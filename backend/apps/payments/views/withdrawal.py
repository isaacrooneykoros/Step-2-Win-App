"""
Withdrawal-related views: bank list, request withdrawal, history, cancel.
"""
import logging
from decimal import Decimal

from django.conf import settings
from django.db import transaction as db_transaction
from django.db.models import Sum
from django.utils import timezone
from django_ratelimit.decorators import ratelimit
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from ..models import WithdrawalRequest
from .. import pochipay
from ._helpers import notify_admin_new_withdrawal

logger = logging.getLogger(__name__)

MIN_WITHDRAWAL = Decimal(str(settings.MIN_WITHDRAWAL_KES))
MAX_WITHDRAWAL = Decimal(str(settings.MAX_WITHDRAWAL_KES))
MAX_DAILY      = Decimal(str(settings.MAX_DAILY_WITHDRAWAL))


@extend_schema(
    responses={
        200: inline_serializer(
            name='GetBanksResponse',
            fields={'banks': serializers.ListField()},
        ),
        502: inline_serializer(name='GetBanksError', fields={'error': serializers.CharField()}),
    },
)
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def get_banks(request):
    """Returns the list of supported banks for bank withdrawals. Cached 24h."""
    try:
        banks = pochipay.get_available_banks()
        return Response({'banks': banks})
    except Exception as e:
        logger.error(f'Failed to fetch bank list: {e}')
        return Response({'error': 'Could not load bank list. Try again.'}, status=502)


@extend_schema(
    request=inline_serializer(
        name='RequestWithdrawalRequest',
        fields={
            'method': serializers.ChoiceField(choices=['mpesa', 'bank', 'paybill']),
            'amount': serializers.DecimalField(max_digits=10, decimal_places=2),
            'phone_number': serializers.CharField(required=False),
            'bank_code': serializers.CharField(required=False),
            'account_number': serializers.CharField(required=False),
            'short_code': serializers.CharField(required=False),
            'is_paybill': serializers.BooleanField(required=False),
        },
    ),
    responses={
        201: inline_serializer(
            name='RequestWithdrawalResponse',
            fields={
                'message': serializers.CharField(),
                'withdrawal_id': serializers.CharField(),
                'amount_kes': serializers.CharField(),
                'method': serializers.CharField(),
                'status': serializers.CharField(),
                'destination': serializers.CharField(),
            },
        ),
        400: inline_serializer(name='RequestWithdrawalBadRequest', fields={'error': serializers.CharField()}),
        500: inline_serializer(name='RequestWithdrawalServerError', fields={'error': serializers.CharField()}),
        502: inline_serializer(name='RequestWithdrawalUpstreamError', fields={'error': serializers.CharField()}),
    },
)
@api_view(['POST'])
@permission_classes([IsAuthenticated])
@ratelimit(key='user', rate='5/h', method='POST', block=True)
def request_withdrawal(request):
    """
    User submits a withdrawal request.
    Flow:
      1. Validate inputs
      2. Check balance (sufficient funds)
      3. Check daily withdrawal limit
      4. Deduct balance immediately (holds the funds)
      5. Create WithdrawalRequest with status='pending_review'
      6. Notify admin
    """
    user   = request.user
    data   = request.data
    method = data.get('method')
    amount = data.get('amount')

    if method not in ('mpesa', 'bank', 'paybill'):
        return Response(
            {'error': 'method must be one of: mpesa, bank, paybill'}, status=400
        )

    try:
        amount = Decimal(str(amount))
    except Exception:
        return Response({'error': 'Invalid amount'}, status=400)

    if amount < MIN_WITHDRAWAL:
        return Response(
            {'error': f'Minimum withdrawal is KES {MIN_WITHDRAWAL}'}, status=400
        )
    if amount > MAX_WITHDRAWAL:
        return Response(
            {'error': f'Maximum single withdrawal is KES {MAX_WITHDRAWAL}'}, status=400
        )

    phone = bank_code = account_number = bank_name = short_code = None
    is_paybill = True

    if method == 'mpesa':
        phone = data.get('phone_number')
        if not phone:
            return Response({'error': 'phone_number is required for M-Pesa'}, status=400)
        try:
            phone = pochipay.format_phone(phone)
        except ValueError as e:
            return Response({'error': str(e)}, status=400)

    elif method == 'bank':
        bank_code      = data.get('bank_code')
        account_number = data.get('account_number')
        if not bank_code or not account_number:
            return Response(
                {'error': 'bank_code and account_number are required for bank withdrawals'},
                status=400
            )
        try:
            banks = pochipay.get_available_banks()
            valid_codes = [b.get('bankCode') for b in banks]
            if bank_code not in valid_codes:
                return Response({'error': 'Invalid bank_code'}, status=400)
            bank_name = next(
                (b.get('name', '') for b in banks if b.get('bankCode') == bank_code), ''
            )
        except Exception:
            return Response({'error': 'Could not validate bank. Try again.'}, status=502)

    else:
        short_code     = data.get('short_code')
        account_number = data.get('account_number')
        is_paybill     = data.get('is_paybill', True)
        if not short_code:
            return Response({'error': 'short_code is required for paybill/till'}, status=400)

    try:
        with db_transaction.atomic():
            locked_user = user.__class__.objects.select_for_update().get(id=user.id)

            if locked_user.wallet_balance < amount:
                return Response(
                    {'error': f'Insufficient balance. Available: KES {locked_user.wallet_balance}'},
                    status=400
                )

            today = timezone.now().date()
            daily_total = WithdrawalRequest.objects.filter(
                user=user,
                created_at__date=today,
                status__in=['pending_review', 'approved', 'processing', 'completed'],
            ).aggregate(t=Sum('amount_kes'))['t'] or Decimal('0')

            if daily_total + amount > MAX_DAILY:
                remaining = MAX_DAILY - daily_total
                return Response(
                    {'error': f'Daily withdrawal limit reached. Remaining today: KES {remaining}'},
                    status=400
                )

            locked_user.wallet_balance -= amount
            locked_user.save(update_fields=['wallet_balance', 'updated_at'])

            withdrawal_data: dict = {
                'user':       user,
                'status':     'pending_review',
                'amount_kes': amount,
                'method':     method,
                'narration':  f'Step2Win withdrawal - {user.username}',
            }

            if method == 'mpesa':
                withdrawal_data['phone_number'] = phone
            elif method == 'bank':
                withdrawal_data['bank_code']       = bank_code
                withdrawal_data['bank_name']       = bank_name
                withdrawal_data['account_number']  = account_number
            else:
                withdrawal_data['short_code']      = short_code
                withdrawal_data['account_number']  = account_number or ''
                withdrawal_data['is_paybill']      = bool(is_paybill)

            withdrawal = WithdrawalRequest.objects.create(**withdrawal_data)

    except Exception as e:
        logger.error(f'Withdrawal request creation failed for user {user.id}: {e}')
        return Response({'error': 'Could not process your request. Try again.'}, status=500)

    notify_admin_new_withdrawal(withdrawal)

    logger.info(
        f'Withdrawal request created | user={user.id} | '
        f'amount=KES {amount} | method={method} | id={withdrawal.id}'
    )

    return Response({
        'message':       'Withdrawal request submitted. Under review — usually processed within 24 hours.',
        'withdrawal_id': str(withdrawal.id),
        'amount_kes':    str(amount),
        'method':        method,
        'status':        'pending_review',
        'destination':   withdrawal.destination_display,
    }, status=status.HTTP_201_CREATED)


@extend_schema(
    responses={
        200: inline_serializer(
            name='WithdrawalHistoryItem',
            many=True,
            fields={
                'id': serializers.CharField(),
                'status': serializers.CharField(),
                'amount_kes': serializers.CharField(),
                'method': serializers.CharField(),
                'destination': serializers.CharField(),
                'mpesa_ref': serializers.CharField(allow_blank=True, allow_null=True),
                'fail_reason': serializers.CharField(allow_blank=True, allow_null=True),
                'created_at': serializers.CharField(),
                'updated_at': serializers.CharField(),
            },
        )
    }
)
@api_view(['GET'])
@permission_classes([IsAuthenticated])
def withdrawal_history(request):
    """Returns the user's withdrawal request history."""
    withdrawals = WithdrawalRequest.objects.filter(
        user=request.user
    ).order_by('-created_at')[:30]

    return Response([
        {
            'id':          str(w.id),
            'status':      w.status,
            'amount_kes':  str(w.amount_kes),
            'method':      w.method,
            'destination': w.destination_display,
            'mpesa_ref':   w.mpesa_reference,
            'fail_reason': w.fail_reason or w.rejection_reason,
            'created_at':  w.created_at.isoformat(),
            'updated_at':  w.updated_at.isoformat(),
        }
        for w in withdrawals
    ])


@extend_schema(
    request=None,
    responses={
        200: inline_serializer(name='CancelWithdrawalResponse', fields={'message': serializers.CharField()}),
        400: inline_serializer(name='CancelWithdrawalBadRequest', fields={'error': serializers.CharField()}),
        404: inline_serializer(name='CancelWithdrawalNotFound', fields={'error': serializers.CharField()}),
    },
)
@api_view(['POST'])
@permission_classes([IsAuthenticated])
def cancel_withdrawal(request, withdrawal_id):
    """
    User cancels their own withdrawal before admin approves it.
    Only possible when status='pending_review'. Refunds the balance immediately.
    """
    try:
        withdrawal = WithdrawalRequest.objects.get(id=withdrawal_id, user=request.user)
    except WithdrawalRequest.DoesNotExist:
        return Response({'error': 'Withdrawal not found'}, status=404)

    if withdrawal.status != 'pending_review':
        return Response(
            {'error': f'Cannot cancel a withdrawal with status: {withdrawal.status}'},
            status=400
        )

    with db_transaction.atomic():
        locked_user = request.user.__class__.objects.select_for_update().get(id=request.user.id)
        locked_user.wallet_balance += withdrawal.amount_kes
        locked_user.save(update_fields=['wallet_balance', 'updated_at'])

        withdrawal.status = 'cancelled'
        withdrawal.save(update_fields=['status', 'updated_at'])

    logger.info(
        f'Withdrawal cancelled by user | id={withdrawal_id} | '
        f'refunded=KES {withdrawal.amount_kes}'
    )
    return Response({'message': 'Withdrawal cancelled. Balance refunded.'})
