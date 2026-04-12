import logging
import uuid
from decimal import Decimal
from datetime import timedelta
from django.conf import settings
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
from .models import PaymentTransaction, CallbackLog, WithdrawalRequest
from apps.core.throttles import DepositRateThrottle, WithdrawalRateThrottle

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
    user   = request.user
    amount = request.data.get('amount')
    phone  = request.data.get('phone_number')

    # ── Validate inputs ────────────────────────────────────────────────────
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
        phone = intasend.format_phone(phone)
    except ValueError as e:
        return Response({'error': str(e)}, status=400)

    # ── Idempotency — reject duplicate in-flight deposits ───────────────────────
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
    # ── Create transaction record first (before calling IntaSend) ──────────
    order_id           = f"DEP-{uuid.uuid4().hex[:20].upper()}"
    tracking_reference = intasend.generate_tracking_reference('DEP')

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

    # ── Send STK Push via IntaSend ─────────────────────────────────────────
    try:
        invoice = intasend.initiate_mpesa_collection(
            order_id     = order_id,
            phone_number = phone,
            amount       = float(amount),
            narration    = 'Step2Win Deposit',
            user_email   = getattr(user, 'email', ''),
        )
        # Store IntaSend's invoice_id for status polling (collection_id field)
        txn.collection_id = invoice.get('invoice_id', '')
        txn.status        = 'pending'
        txn.save(update_fields=['collection_id', 'status', 'updated_at'])

    except Exception as e:
        txn.status     = 'failed'
        txn.fail_reason = str(e)
        txn.save(update_fields=['status', 'fail_reason', 'updated_at'])
        logger.error(f'Deposit STK Push failed for user {user.id}: {e}')

        if isinstance(e, intasend.IntaSendAPIError):
            # Configuration/auth issues should surface as 400 for easier debugging.
            if e.status_code == 400 or 'api key missing' in str(e).lower():
                return Response({'error': str(e)}, status=400)

        return Response({'error': 'Payment initiation failed. Please try again.'}, status=502)

    return Response({
        'message':    'M-Pesa STK Push sent. Check your phone to complete payment.',
        'order_id':   order_id,
        'amount_kes': str(amount),
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
    import json
    import hmac
    import hashlib

    # ── Optional webhook challenge verification ───────────────────────────
    webhook_secret = getattr(settings, 'INTASEND_WEBHOOK_SECRET', None)
    if webhook_secret:
        provided_sig = request.headers.get('X-IntaSend-Signature', '')
        if provided_sig:
            expected_sig = hmac.new(
                webhook_secret.encode(),
                request.body,
                hashlib.sha256,
            ).hexdigest()
            if not hmac.compare_digest(provided_sig, expected_sig):
                logger.warning('Deposit callback: invalid webhook signature — rejected')
                return JsonResponse({'error': 'Invalid signature'}, status=403)

    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    # ── Extract IntaSend invoice fields ───────────────────────────────────
    invoice      = payload.get('invoice', {})
    order_id     = invoice.get('api_ref', '')          # our order_id passed as api_ref
    state        = invoice.get('state', '')
    is_successful = state == 'COMPLETE'
    mpesa_ref    = invoice.get('mpesa_reference', '')
    fail_reason  = invoice.get('failed_reason', '') or invoice.get('failed_code', '')

    # Log the raw callback first — always, even if we reject it
    log = CallbackLog.objects.create(
        type        = 'deposit',
        raw_payload = payload,
        order_id    = order_id,
    )

    if not order_id:
        logger.warning(f'Deposit callback missing api_ref (order_id): {payload}')
        return JsonResponse({'status': 'ok'})  # always 200 to IntaSend

    # ── Idempotency: check if already processed ───────────────────────────
    try:
        txn = PaymentTransaction.objects.get(order_id=order_id, type='deposit')
    except PaymentTransaction.DoesNotExist:
        logger.error(f'Deposit callback for unknown order_id={order_id}')
        return JsonResponse({'status': 'ok'})

    if txn.status in ('completed', 'failed', 'cancelled'):
        logger.info(f'Duplicate deposit callback for order_id={order_id} — already {txn.status}')
        return JsonResponse({'status': 'ok'})

    # ── Process in atomic transaction — prevents double-credit ───────────
    try:
        with db_transaction.atomic():
            if is_successful:
                # Credit the user's wallet
                from apps.users.models import User
                user = User.objects.select_for_update().get(id=txn.user_id)
                user.wallet_balance = user.wallet_balance + txn.amount_kes
                user.save(update_fields=['wallet_balance', 'updated_at'])

                # Update transaction
                txn.status               = 'completed'
                txn.mpesa_reference      = mpesa_ref
                txn.callback_received_at = timezone.now()
                txn.save(update_fields=['status', 'mpesa_reference',
                                        'callback_received_at', 'updated_at'])

                # Also create a WalletTransaction record for the history
                _create_wallet_transaction(
                    user=txn.user, type='deposit',
                    amount=txn.amount_kes, reference=order_id,
                    description=f'M-Pesa deposit via {mpesa_ref}',
                )

                logger.info(f'Deposit completed | user={txn.user.id} | '
                            f'amount=KES {txn.amount_kes} | mpesa={mpesa_ref}')

                # Send push notification to user
                _notify_user(txn.user, 'deposit_success',
                             amount=txn.amount_kes, mpesa_ref=mpesa_ref)

            else:
                txn.status               = 'failed' if fail_reason else 'cancelled'
                txn.fail_reason          = fail_reason
                txn.callback_received_at = timezone.now()
                txn.save(update_fields=['status', 'fail_reason',
                                        'callback_received_at', 'updated_at'])

                logger.info(f'Deposit failed | user={txn.user.id} | reason={txn.fail_reason}')
                _notify_user(txn.user, 'deposit_failed',
                             amount=txn.amount_kes, reason=txn.fail_reason)

        log.processed = True
        log.save(update_fields=['processed'])

    except Exception as e:
        logger.error(f'Deposit callback processing error for {order_id}: {e}')
        # Still return 200 so IntaSend doesn't retry endlessly
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
    import json
    import hmac
    import hashlib

    # ── Optional webhook signature verification ───────────────────────────
    webhook_secret = getattr(settings, 'INTASEND_WEBHOOK_SECRET', None)
    if webhook_secret:
        provided_sig = request.headers.get('X-IntaSend-Signature', '')
        if provided_sig:
            expected_sig = hmac.new(
                webhook_secret.encode(),
                request.body,
                hashlib.sha256,
            ).hexdigest()
            if not hmac.compare_digest(provided_sig, expected_sig):
                logger.warning('Payout callback: invalid webhook signature — rejected')
                return JsonResponse({'error': 'Invalid signature'}, status=403)

    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    # ── Extract IntaSend send-money fields ────────────────────────────────
    tracking_ref  = payload.get('tracking_id', '')
    status_str    = payload.get('status', '')
    is_successful = status_str == 'COMPLETE'
    transactions  = payload.get('transactions', [])
    first_txn     = transactions[0] if transactions else {}
    mpesa_ref     = first_txn.get('mpesa_reference', '')
    fail_reason   = (
        first_txn.get('failed_reason', '')
        or payload.get('failed_reason', '')
    )

    log = CallbackLog.objects.create(
        type        = 'payout',
        raw_payload = payload,
        order_id    = tracking_ref,
    )

    if not tracking_ref:
        return JsonResponse({'status': 'ok'})

    try:
        txn = PaymentTransaction.objects.get(
            tracking_reference=tracking_ref, type='payout'
        )
    except PaymentTransaction.DoesNotExist:
        logger.error(f'Payout callback for unknown tracking_id={tracking_ref}')
        return JsonResponse({'status': 'ok'})

    if txn.status in ('completed', 'failed'):
        return JsonResponse({'status': 'ok'})

    try:
        with db_transaction.atomic():
            if is_successful:
                txn.status               = 'completed'
                txn.mpesa_reference      = mpesa_ref
                txn.callback_received_at = timezone.now()
                txn.save(update_fields=['status', 'mpesa_reference',
                                        'callback_received_at', 'updated_at'])

                logger.info(f'Payout completed | user={txn.user.id} | '
                            f'amount=KES {txn.amount_kes} | mpesa={mpesa_ref}')
                _notify_user(txn.user, 'payout_success',
                             amount=txn.amount_kes, mpesa_ref=mpesa_ref)

                # If this payout originated from wallet withdrawal, mark it completed
                from apps.wallet.models import Withdrawal
                try:
                    wd = Withdrawal.objects.select_for_update().get(reference_number=txn.order_id)
                    wd.status = 'completed'
                    wd.processed_at = timezone.now()
                    wd.save(update_fields=['status', 'processed_at'])
                except Withdrawal.DoesNotExist:
                    pass

            else:
                txn.status               = 'failed'
                txn.fail_reason          = fail_reason
                txn.callback_received_at = timezone.now()
                txn.save(update_fields=['status', 'fail_reason',
                                        'callback_received_at', 'updated_at'])

                logger.warning(f'Payout failed | user={txn.user.id} | reason={fail_reason}')

                # Refund the user's wallet on payout failure
                from apps.users.models import User
                user = User.objects.select_for_update().get(id=txn.user_id)
                user.wallet_balance = user.wallet_balance + txn.amount_kes
                user.save(update_fields=['wallet_balance', 'updated_at'])
                _notify_user(txn.user, 'payout_failed',
                             amount=txn.amount_kes, reason=fail_reason)

                # If this payout originated from wallet withdrawal, mark it failed
                from apps.wallet.models import Withdrawal
                try:
                    wd = Withdrawal.objects.select_for_update().get(reference_number=txn.order_id)
                    wd.status = 'failed'
                    wd.rejection_reason = fail_reason or 'Payout failed'
                    wd.processed_at = timezone.now()
                    wd.save(update_fields=['status', 'rejection_reason', 'processed_at'])
                except Withdrawal.DoesNotExist:
                    pass

        log.processed = True
        log.save(update_fields=['processed'])

    except Exception as e:
        logger.error(f'Payout callback error for {tracking_ref}: {e}')

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
    
    user_obj = User.objects.get(id=user.id)
    balance_before = user_obj.wallet_balance - amount
    
    WalletTransaction.objects.create(
        user            = user,
        type            = type,
        amount          = amount,
        balance_before  = balance_before,
        balance_after   = user_obj.wallet_balance,
        description     = description,
        reference_id    = reference,
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

    if method == 'mpesa':
        phone = data.get('phone_number')
        if not phone:
            return Response({'error': 'phone_number is required for M-Pesa'}, status=400)
        try:
            phone = intasend.format_phone(phone)
        except ValueError as e:
            return Response({'error': str(e)}, status=400)

    elif method == 'bank':
        bank_code = data.get('bank_code')
        account_number = data.get('account_number')
        if not bank_code or not account_number:
            return Response(
                {'error': 'bank_code and account_number are required for bank withdrawals'},
                status=400
            )
        try:
            banks = intasend.get_available_banks()
            valid_codes = [b.get('bankCode') or b.get('bank_code') for b in banks]
            if bank_code not in valid_codes:
                return Response({'error': 'Invalid bank_code'}, status=400)
            bank_name = next(
                (b.get('name', '') for b in banks
                 if (b.get('bankCode') or b.get('bank_code')) == bank_code),
                ''
            )
        except Exception:
            return Response({'error': 'Could not validate bank. Try again.'}, status=502)

    else:
        short_code = data.get('short_code')
        account_number = data.get('account_number')
        is_paybill = data.get('is_paybill', True)
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

            locked_user.wallet_balance = locked_user.wallet_balance - amount
            locked_user.save(update_fields=['wallet_balance', 'updated_at'])

            withdrawal_data = {
                'user':       user,
                'status':     'pending_review',
                'amount_kes': amount,
                'method':     method,
                'narration':  f'Step2Win withdrawal - {user.username}',
            }

            if method == 'mpesa':
                withdrawal_data['phone_number'] = phone
            elif method == 'bank':
                withdrawal_data['bank_code'] = bank_code
                withdrawal_data['bank_name'] = bank_name
                withdrawal_data['account_number'] = account_number
            else:
                withdrawal_data['short_code'] = short_code
                withdrawal_data['account_number'] = account_number or ''
                withdrawal_data['is_paybill'] = bool(is_paybill)

            withdrawal = WithdrawalRequest.objects.create(**withdrawal_data)

    except Exception as e:
        logger.error(f'Withdrawal request creation failed for user {user.id}: {e}')
        return Response({'error': 'Could not process your request. Try again.'}, status=500)

    _notify_admin_new_withdrawal(withdrawal)

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
    import json
    import hmac
    import hashlib

    # ── Optional webhook signature verification ───────────────────────────
    webhook_secret = getattr(settings, 'INTASEND_WEBHOOK_SECRET', None)
    if webhook_secret:
        provided_sig = request.headers.get('X-IntaSend-Signature', '')
        if provided_sig:
            expected_sig = hmac.new(
                webhook_secret.encode(),
                request.body,
                hashlib.sha256,
            ).hexdigest()
            if not hmac.compare_digest(provided_sig, expected_sig):
                logger.warning('Withdrawal callback: invalid webhook signature — rejected')
                return JsonResponse({'error': 'Invalid signature'}, status=403)

    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    # ── Extract IntaSend send-money fields ────────────────────────────────
    tracking_ref  = payload.get('tracking_id', '')
    status_str    = payload.get('status', '')
    is_successful = status_str == 'COMPLETE'
    transactions  = payload.get('transactions', [])
    first_txn     = transactions[0] if transactions else {}
    mpesa_ref     = first_txn.get('mpesa_reference', '')
    fail_reason   = (
        first_txn.get('failed_reason', '')
        or payload.get('failed_reason', '')
    )

    log = CallbackLog.objects.create(
        type='withdrawal',
        raw_payload=payload,
        order_id=tracking_ref,
    )

    if not tracking_ref:
        return JsonResponse({'status': 'ok'})

    try:
        withdrawal = WithdrawalRequest.objects.get(tracking_reference=tracking_ref)
    except WithdrawalRequest.DoesNotExist:
        logger.error(f'Withdrawal callback for unknown tracking_id={tracking_ref}')
        return JsonResponse({'status': 'ok'})

    if withdrawal.status in ('completed', 'failed'):
        logger.info(f'Duplicate withdrawal callback ignored | ref={tracking_ref}')
        return JsonResponse({'status': 'ok'})

    try:
        with db_transaction.atomic():
            if is_successful:
                withdrawal.status = 'completed'
                withdrawal.mpesa_reference = mpesa_ref
                withdrawal.callback_received_at = timezone.now()
                withdrawal.save(update_fields=[
                    'status', 'mpesa_reference', 'callback_received_at', 'updated_at'
                ])
                logger.info(
                    f'Withdrawal completed | user={withdrawal.user.id} | '
                    f'KES {withdrawal.amount_kes} | mpesa={mpesa_ref}'
                )
                _notify_user(
                    withdrawal.user,
                    'withdrawal_success',
                    amount=withdrawal.amount_kes,
                    mpesa_ref=mpesa_ref,
                    method=withdrawal.method,
                )

            else:
                locked_user = withdrawal.user.__class__.objects.select_for_update().get(id=withdrawal.user.id)
                locked_user.wallet_balance = locked_user.wallet_balance + withdrawal.amount_kes
                locked_user.save(update_fields=['wallet_balance', 'updated_at'])

                withdrawal.status = 'failed'
                withdrawal.fail_reason = fail_reason
                withdrawal.callback_received_at = timezone.now()
                withdrawal.save(update_fields=[
                    'status', 'fail_reason', 'callback_received_at', 'updated_at'
                ])
                logger.warning(
                    f'Withdrawal failed — balance refunded | '
                    f'user={withdrawal.user.id} | reason={fail_reason}'
                )
                _notify_user(
                    withdrawal.user,
                    'withdrawal_failed',
                    amount=withdrawal.amount_kes,
                    reason=fail_reason,
                )

        log.processed = True
        log.save(update_fields=['processed'])

    except Exception as e:
        logger.error(f'Withdrawal callback processing error | ref={tracking_ref}: {e}')

    return JsonResponse({'status': 'ok'})


def _notify_admin_new_withdrawal(withdrawal):
    """Notify admins a new withdrawal is pending review."""
    logger.info(
        f'ADMIN ALERT: New withdrawal pending | '
        f'user={withdrawal.user.username} | '
        f'KES {withdrawal.amount_kes} | {withdrawal.destination_display}'
    )
