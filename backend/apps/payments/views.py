import json
import logging
from decimal import Decimal
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.db import transaction as db_transaction
from django.db.models import Sum
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST
from django.http import JsonResponse
from django_ratelimit.decorators import ratelimit
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework import serializers
from drf_spectacular.utils import extend_schema, inline_serializer

from . import intasend
from .serializers import InitiateDepositSerializer, WithdrawalRequestInputSerializer
from .services import (
    PaymentsServiceError,
    approve_withdrawal_and_send,
    debit_wallet,
    initiate_deposit as initiate_deposit_service,
    log_callback,
    process_deposit_callback,
    process_payout_callback,
    process_withdrawal_callback,
    reject_withdrawal_request,
    request_withdrawal as create_withdrawal_request,
    verify_intasend_signature,
)
from .models import PaymentTransaction, CallbackLog, WithdrawalRequest
from apps.core.throttles import DepositRateThrottle, WithdrawalRateThrottle
from apps.core.idempotency import acquire_idempotency_slot

logger = logging.getLogger(__name__)

# Minimum and maximum deposit limits
MIN_DEPOSIT = Decimal(str(settings.MIN_DEPOSIT_KES))
MAX_DEPOSIT = Decimal(str(settings.MAX_DEPOSIT_KES))


# ── Deposit ───────────────────────────────────────────────────────────────────

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

    Request body:
        amount (float): Amount in KES to deposit
        phone_number (str): User's M-Pesa number
    """
    serializer = InitiateDepositSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    idem_key = request.headers.get('X-Idempotency-Key')
    if not acquire_idempotency_slot(
        scope='payments_deposit',
        user_id=request.user.id,
        idempotency_key=idem_key,
        ttl_seconds=180,
    ):
        return Response({'error': 'Duplicate request'}, status=status.HTTP_409_CONFLICT)

    try:
        txn = initiate_deposit_service(
            request.user,
            serializer.validated_data['amount'],
            serializer.validated_data['phone_number'],
        )
    except PaymentsServiceError as exc:
        return Response({'error': exc.message}, status=exc.status_code)
    except Exception as exc:
        logger.error(f'Deposit STK Push failed for user {request.user.id}: {exc}')
        if isinstance(exc, intasend.IntaSendAPIError):
            if exc.status_code == 400 or 'api key missing' in str(exc).lower():
                return Response({'error': str(exc)}, status=400)
        return Response({'error': 'Payment initiation failed. Please try again.'}, status=502)

    return Response({
        'message':    'M-Pesa STK Push sent. Check your phone to complete payment.',
        'order_id':   txn.order_id,
        'amount_kes': str(txn.amount_kes),
        'status':     'pending',
    })


# ── Deposit Callback (PUBLIC — no auth required) ──────────────────────────────

@csrf_exempt
@require_POST
def deposit_callback(request):
    """
    IntaSend calls this URL when a deposit (STK Push) M-Pesa transaction completes.
    Register this URL in the IntaSend dashboard under Settings > Webhooks.
    This endpoint MUST be public (no authentication).
    MUST return 200 quickly — IntaSend may retry if it times out.

    IntaSend webhook payload format:
        {
          "invoice": {
            "invoice_id": "...",
            "state": "COMPLETE" | "FAILED" | "PENDING",
            "api_ref": "<our order_id>",
            "mpesa_reference": "MPESA_TXN_REF",
            "failed_reason": null | "...",
            "value": 100,
            ...
          }
        }
    """
    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    try:
        verify_intasend_signature(request, 'Deposit callback')
        process_deposit_callback(payload)
    except ImproperlyConfigured as exc:
        return JsonResponse({'error': str(exc)}, status=500)
    except PaymentsServiceError as exc:
        return JsonResponse({'error': exc.message}, status=exc.status_code)
    except PaymentTransaction.DoesNotExist:
        logger.error('Deposit callback for unknown order_id=%s', payload.get('invoice', {}).get('api_ref', ''))
        return JsonResponse({'status': 'ok'})

    return JsonResponse({'status': 'ok'})


# ── Payout Callback (PUBLIC — no auth required) ───────────────────────────────

@csrf_exempt
@require_POST
def payout_callback(request):
    """
    IntaSend calls this URL when a challenge payout (send-money) completes.
    This endpoint MUST be public (no authentication).
    MUST return 200 quickly — IntaSend may retry if it times out.

    IntaSend send-money webhook payload format:
        {
          "tracking_id": "<IntaSend batch tracking_id stored as tracking_reference>",
          "status": "COMPLETE" | "FAILED" | "PENDING",
          "transactions": [
            {
              "status": "COMPLETE",
              "account": "2547XXXXXXXX",
              "amount": 100,
              "mpesa_reference": "MPESA_TXN_REF",
              "failed_reason": null
            }
          ]
        }
    """
    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    try:
        verify_intasend_signature(request, 'Payout callback')
        process_payout_callback(payload)
    except ImproperlyConfigured as exc:
        return JsonResponse({'error': str(exc)}, status=500)
    except PaymentsServiceError as exc:
        return JsonResponse({'error': exc.message}, status=exc.status_code)
    except PaymentTransaction.DoesNotExist:
        logger.error('Payout callback for unknown tracking_id=%s', payload.get('tracking_id', ''))

    return JsonResponse({'status': 'ok'})


# ── Wallet Status ─────────────────────────────────────────────────────────────

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


# ── Internal Helpers ──────────────────────────────────────────────────────────

def _create_wallet_transaction(user, type, amount, reference, description):
    """
    Creates a record in the existing WalletTransaction model.
    """
    from apps.wallet.models import WalletTransaction
    from apps.users.models import User

    with db_transaction.atomic():
        user_obj = User.objects.select_for_update().get(id=user.id)
        balance_before = user_obj.wallet_balance
        balance_after = balance_before + amount

        WalletTransaction.objects.create(
            user=user_obj,
            type=type,
            amount=amount,
            balance_before=balance_before,
            balance_after=balance_after,
            description=description,
            reference_id=reference,
        )


def _notify_user(user, event: str, **kwargs):
    """
    Sends in-app notification / push notification.
    Connect to your existing notification system.
    """
    # TODO: integrate with your existing notification system
    # For now, log it
    logger.info(f'Notification | user={user.id} | event={event} | data={kwargs}')


# ────────────────────────────────────────────────────────────────────────────
# WITHDRAWALS
# ────────────────────────────────────────────────────────────────────────────

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
        banks = intasend.get_available_banks()
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
@throttle_classes([WithdrawalRateThrottle])
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
      7. Return confirmation to user
    """
    try:
        idem_key = request.headers.get('X-Idempotency-Key')
        if not acquire_idempotency_slot(
            scope='payments_withdrawal',
            user_id=request.user.id,
            idempotency_key=idem_key,
            ttl_seconds=180,
        ):
            return Response({'error': 'Duplicate request'}, status=status.HTTP_409_CONFLICT)

        serializer = WithdrawalRequestInputSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        withdrawal = create_withdrawal_request(request.user, serializer.validated_data)
    except PaymentsServiceError as exc:
        return Response({'error': exc.message}, status=exc.status_code)

    _notify_admin_new_withdrawal(withdrawal)

    logger.info(
        f'Withdrawal request created | user={request.user.id} | '
        f'amount=KES {withdrawal.amount_kes} | method={withdrawal.method} | id={withdrawal.id}'
    )

    return Response({
        'message':       'Withdrawal request submitted. Under review — usually processed within 24 hours.',
        'withdrawal_id': str(withdrawal.id),
        'amount_kes':    str(withdrawal.amount_kes),
        'method':        withdrawal.method,
        'status':        withdrawal.status,
        'destination':   withdrawal.destination_display,
    }, status=201)


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
    Only possible when status='pending_review'.
    Refunds the balance immediately.
    """
    try:
        withdrawal = WithdrawalRequest.objects.get(
            id=withdrawal_id, user=request.user
        )
    except WithdrawalRequest.DoesNotExist:
        return Response({'error': 'Withdrawal not found'}, status=404)

    if withdrawal.status != 'pending_review':
        return Response(
            {'error': f'Cannot cancel a withdrawal with status: {withdrawal.status}'},
            status=400
        )

    with db_transaction.atomic():
        locked_user = request.user.__class__.objects.select_for_update().get(id=request.user.id)
        locked_user.wallet_balance = locked_user.wallet_balance + withdrawal.amount_kes
        locked_user.save(update_fields=['wallet_balance', 'updated_at'])

        withdrawal.status = 'cancelled'
        withdrawal.save(update_fields=['status', 'updated_at'])

    logger.info(f'Withdrawal cancelled by user | id={withdrawal_id} | '
                f'refunded=KES {withdrawal.amount_kes}')
    return Response({'message': 'Withdrawal cancelled. Balance refunded.'})


@csrf_exempt
@require_POST
def withdrawal_callback(request):
    """
    IntaSend calls this URL when an admin-approved withdrawal disbursement completes.
    Public endpoint — no authentication.
    Always return 200 quickly.

    IntaSend send-money webhook payload format:
        {
          "tracking_id": "<IntaSend tracking_id stored as WithdrawalRequest.tracking_reference>",
          "status": "COMPLETE" | "FAILED" | "PENDING",
          "transactions": [
            {
              "status": "COMPLETE",
              "account": "2547XXXXXXXX",
              "amount": 100,
              "mpesa_reference": "MPESA_TXN_REF",
              "failed_reason": null
            }
          ]
        }
    """
    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    try:
        verify_intasend_signature(request, 'Withdrawal callback')
        process_withdrawal_callback(payload)
    except ImproperlyConfigured as exc:
        return JsonResponse({'error': str(exc)}, status=500)
    except PaymentsServiceError as exc:
        return JsonResponse({'error': exc.message}, status=exc.status_code)
    except WithdrawalRequest.DoesNotExist:
        logger.error('Withdrawal callback for unknown tracking_id=%s', payload.get('tracking_id', ''))

    return JsonResponse({'status': 'ok'})


def _notify_admin_new_withdrawal(withdrawal):
    """Notify admins a new withdrawal is pending review."""
    logger.info(
        f'ADMIN ALERT: New withdrawal pending | '
        f'user={withdrawal.user.username} | '
        f'KES {withdrawal.amount_kes} | {withdrawal.destination_display}'
    )
