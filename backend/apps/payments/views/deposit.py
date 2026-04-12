"""
Deposit-related views: initiate deposit, deposit status, wallet status.
"""
import logging
import uuid
from datetime import timedelta
from decimal import Decimal

from django.conf import settings
from django.utils import timezone
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.core.throttles import DepositRateThrottle
from ..models import PaymentTransaction
from .. import pochipay

logger = logging.getLogger(__name__)

MIN_DEPOSIT = Decimal(str(settings.MIN_DEPOSIT_KES))
MAX_DEPOSIT = Decimal(str(settings.MAX_DEPOSIT_KES))


@extend_schema(
    request=inline_serializer(
        name='InitiateDepositRequest',
        fields={
            'amount': serializers.DecimalField(max_digits=10, decimal_places=2),
            'phone_number': serializers.CharField(),
        },
    ),
    responses={
        200: inline_serializer(
            name='InitiateDepositResponse',
            fields={
                'message': serializers.CharField(),
                'order_id': serializers.CharField(),
                'amount_kes': serializers.CharField(),
                'status': serializers.CharField(),
            },
        ),
        400: inline_serializer(name='InitiateDepositBadRequest', fields={'error': serializers.CharField()}),
        502: inline_serializer(name='InitiateDepositUpstreamError', fields={'error': serializers.CharField()}),
    },
)
@api_view(['POST'])
@permission_classes([IsAuthenticated])
@throttle_classes([DepositRateThrottle])
def initiate_deposit(request):
    """
    Step 1 of deposit flow.
    Creates a PaymentTransaction and sends STK Push to user's phone.
    Returns immediately — actual credit happens in deposit_callback.
    """
    user   = request.user
    amount = request.data.get('amount')
    phone  = request.data.get('phone_number')

    if not amount or not phone:
        return Response({'error': 'amount and phone_number are required'}, status=400)

    try:
        amount = Decimal(str(amount))
    except Exception:
        return Response({'error': 'Invalid amount'}, status=400)

    if amount < MIN_DEPOSIT:
        return Response({'error': f'Minimum deposit is KES {MIN_DEPOSIT}'}, status=400)
    if amount > MAX_DEPOSIT:
        return Response({'error': f'Maximum deposit is KES {MAX_DEPOSIT}'}, status=400)

    try:
        phone = pochipay.format_phone(phone)
    except ValueError:
        return Response({'error': 'Invalid phone number format. Use format: 07XXXXXXXX or +254XXXXXXXXX'}, status=400)

    recent_pending = PaymentTransaction.objects.filter(
        user=user,
        type='deposit',
        status__in=['initiated', 'pending'],
        created_at__gte=timezone.now() - timedelta(minutes=5),
    ).first()
    if recent_pending:
        return Response({
            'error': 'You already have a pending deposit. '
                     'Please wait for it to complete before initiating another.',
            'order_id': recent_pending.order_id,
        }, status=400)

    order_id           = f"DEP-{uuid.uuid4().hex[:20].upper()}"
    tracking_reference = pochipay.generate_tracking_reference('DEP')

    txn = PaymentTransaction.objects.create(
        user               = user,
        type               = 'deposit',
        status             = 'initiated',
        amount_kes         = amount,
        order_id           = order_id,
        tracking_reference = tracking_reference,
        phone_number       = phone,
        narration          = f'Step2Win wallet deposit - {user.username}',
    )

    try:
        result = pochipay.initiate_mpesa_collection(
            order_id        = order_id,
            bill_ref_number = f'S2W-{user.id}',
            phone_number    = phone,
            amount          = float(amount),
            narration       = 'Step2Win Deposit',
        )
        txn.collection_id = result.get('collectionId', '')
        txn.status        = 'pending'
        txn.save(update_fields=['collection_id', 'status', 'updated_at'])

    except Exception as e:
        txn.status      = 'failed'
        txn.fail_reason = str(e)
        txn.save(update_fields=['status', 'fail_reason', 'updated_at'])
        logger.error(f'Deposit STK Push failed for user {user.id}: {e}')

        if isinstance(e, pochipay.PochiPayAPIError):
            # Return a generic client-friendly message — do not expose internal
            # API error details (which may include credential info) to the user.
            if e.status_code == 400 or 'credentials missing' in str(e).lower():
                return Response({'error': 'Payment provider configuration error. Please contact support.'}, status=400)

        return Response({'error': 'Payment initiation failed. Please try again.'}, status=502)

    return Response({
        'message':    'M-Pesa STK Push sent. Check your phone to complete payment.',
        'order_id':   order_id,
        'amount_kes': str(amount),
        'status':     'pending',
    })


@extend_schema(
    responses={
        200: inline_serializer(
            name='WalletStatusResponse',
            fields={
                'balance_kes': serializers.CharField(),
                'transactions': inline_serializer(
                    name='WalletStatusTransaction',
                    many=True,
                    fields={
                        'id': serializers.CharField(),
                        'type': serializers.CharField(),
                        'status': serializers.CharField(),
                        'amount_kes': serializers.CharField(),
                        'mpesa_ref': serializers.CharField(allow_blank=True, allow_null=True),
                        'created_at': serializers.CharField(),
                    },
                ),
            },
        )
    }
)
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def wallet_status(request):
    """Returns the user's wallet balance and recent transactions."""
    user = request.user

    recent_payments = PaymentTransaction.objects.filter(
        user=user
    ).order_by('-created_at')[:20]

    return Response({
        'balance_kes': str(user.wallet_balance),
        'transactions': [
            {
                'id':          str(t.id),
                'type':        t.type,
                'status':      t.status,
                'amount_kes':  str(t.amount_kes),
                'mpesa_ref':   t.mpesa_reference,
                'created_at':  t.created_at.isoformat(),
            }
            for t in recent_payments
        ],
    })


@extend_schema(
    responses={
        200: inline_serializer(
            name='DepositStatusResponse',
            fields={
                'order_id': serializers.CharField(),
                'status': serializers.CharField(),
                'amount_kes': serializers.CharField(),
                'mpesa_ref': serializers.CharField(allow_blank=True, allow_null=True),
            },
        ),
        404: inline_serializer(name='DepositStatusNotFound', fields={'error': serializers.CharField()}),
    },
)
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def deposit_status(request, order_id):
    """Polls the status of a specific deposit. Used by frontend while waiting."""
    try:
        txn = PaymentTransaction.objects.get(order_id=order_id, user=request.user)
    except PaymentTransaction.DoesNotExist:
        return Response({'error': 'Transaction not found'}, status=404)

    return Response({
        'order_id':   order_id,
        'status':     txn.status,
        'amount_kes': str(txn.amount_kes),
        'mpesa_ref':  txn.mpesa_reference,
    })
