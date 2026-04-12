"""
PochPay webhook callback handlers: deposit, payout, and withdrawal.
All endpoints are PUBLIC — no authentication — and must return 200 quickly.
"""
import hashlib
import hmac
import json
import logging

from django.conf import settings
from django.db import transaction as db_transaction
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

from ..models import CallbackLog, PaymentTransaction
from ._helpers import create_wallet_transaction, notify_user

logger = logging.getLogger(__name__)


def _verify_webhook_signature(request) -> bool:
    """Returns True if the webhook secret is not configured or the signature matches."""
    webhook_secret = getattr(settings, 'POCHIPAY_WEBHOOK_SECRET', None)
    if not webhook_secret:
        return True
    provided_sig = request.headers.get('X-Pochipay-Signature', '')
    expected_sig = hmac.new(
        webhook_secret.encode(),
        request.body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(provided_sig, expected_sig)


@csrf_exempt
@require_POST
def deposit_callback(request):
    """
    PochPay calls this URL when a deposit M-Pesa transaction completes.
    This endpoint MUST be public (no authentication).
    MUST return 200 quickly — PochPay may retry if it times out.

    Callback payload:
        orderId, billRefNumber, phoneNumber, amount,
        thirdPartyReference, failReason, isSuccessful
    """
    if not _verify_webhook_signature(request):
        logger.warning('Deposit callback: invalid webhook signature — rejected')
        return JsonResponse({'error': 'Invalid signature'}, status=403)

    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    log = CallbackLog.objects.create(
        type        = 'deposit',
        raw_payload = payload,
        order_id    = payload.get('orderId', ''),
    )

    order_id      = payload.get('orderId')
    is_successful = payload.get('isSuccessful', False)
    mpesa_ref     = payload.get('thirdPartyReference', '')
    fail_reason   = payload.get('failReason', '')

    if not order_id:
        logger.warning(f'Deposit callback missing orderId: {payload}')
        return JsonResponse({'status': 'ok'})

    try:
        txn = PaymentTransaction.objects.get(order_id=order_id, type='deposit')
    except PaymentTransaction.DoesNotExist:
        logger.error(f'Deposit callback for unknown order_id={order_id}')
        return JsonResponse({'status': 'ok'})

    if txn.status in ('completed', 'failed', 'cancelled'):
        logger.info(f'Duplicate deposit callback for order_id={order_id} — already {txn.status}')
        return JsonResponse({'status': 'ok'})

    try:
        with db_transaction.atomic():
            if is_successful:
                from apps.users.models import User
                user = User.objects.select_for_update().get(id=txn.user_id)
                user.wallet_balance += txn.amount_kes
                user.save(update_fields=['wallet_balance', 'updated_at'])

                txn.status               = 'completed'
                txn.mpesa_reference      = mpesa_ref
                txn.callback_received_at = timezone.now()
                txn.save(update_fields=['status', 'mpesa_reference',
                                        'callback_received_at', 'updated_at'])

                create_wallet_transaction(
                    user=txn.user, type='deposit',
                    amount=txn.amount_kes, reference=order_id,
                    description=f'M-Pesa deposit via {mpesa_ref}',
                )

                logger.info(
                    f'Deposit completed | user={txn.user.id} | '
                    f'amount=KES {txn.amount_kes} | mpesa={mpesa_ref}'
                )
                notify_user(txn.user, 'deposit_success',
                            amount=txn.amount_kes, mpesa_ref=mpesa_ref)
            else:
                txn.status               = 'failed' if fail_reason else 'cancelled'
                txn.fail_reason          = fail_reason or payload.get('resultDescription', '')
                txn.callback_received_at = timezone.now()
                txn.save(update_fields=['status', 'fail_reason',
                                        'callback_received_at', 'updated_at'])

                logger.info(f'Deposit failed | user={txn.user.id} | reason={txn.fail_reason}')
                notify_user(txn.user, 'deposit_failed',
                            amount=txn.amount_kes, reason=txn.fail_reason)

        log.processed = True
        log.save(update_fields=['processed'])

    except Exception as e:
        logger.error(f'Deposit callback processing error for {order_id}: {e}')

    return JsonResponse({'status': 'ok'})


@csrf_exempt
@require_POST
def payout_callback(request):
    """
    PochPay calls this URL when a challenge payout completes.
    Callback payload:
        successful, requestId, trackingReference, thirdPartyReference, failReason
    """
    if not _verify_webhook_signature(request):
        logger.warning('Payout callback: invalid webhook signature — rejected')
        return JsonResponse({'error': 'Invalid signature'}, status=403)

    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    log = CallbackLog.objects.create(
        type        = 'payout',
        raw_payload = payload,
        order_id    = payload.get('trackingReference', ''),
    )

    tracking_ref  = payload.get('trackingReference')
    is_successful = payload.get('successful', False)
    mpesa_ref     = payload.get('thirdPartyReference', '')
    fail_reason   = payload.get('failReason', '')

    if not tracking_ref:
        return JsonResponse({'status': 'ok'})

    try:
        txn = PaymentTransaction.objects.get(tracking_reference=tracking_ref, type='payout')
    except PaymentTransaction.DoesNotExist:
        logger.error(f'Payout callback for unknown trackingReference={tracking_ref}')
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

                logger.info(
                    f'Payout completed | user={txn.user.id} | '
                    f'amount=KES {txn.amount_kes} | mpesa={mpesa_ref}'
                )
                notify_user(txn.user, 'payout_success',
                            amount=txn.amount_kes, mpesa_ref=mpesa_ref)

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

                from apps.users.models import User
                user = User.objects.select_for_update().get(id=txn.user_id)
                user.wallet_balance += txn.amount_kes
                user.save(update_fields=['wallet_balance', 'updated_at'])
                notify_user(txn.user, 'payout_failed',
                            amount=txn.amount_kes, reason=fail_reason)

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


@csrf_exempt
@require_POST
def withdrawal_callback(request):
    """
    PochPay calls this URL when a withdrawal disbursement completes or fails.
    Always return 200 quickly.

    Payload: successful, requestId, trackingReference, thirdPartyReference, failReason
    """
    if not _verify_webhook_signature(request):
        logger.warning('Withdrawal callback: invalid webhook signature — rejected')
        return JsonResponse({'error': 'Invalid signature'}, status=403)

    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    log = CallbackLog.objects.create(
        type='withdrawal',
        raw_payload=payload,
        order_id=payload.get('trackingReference', ''),
    )

    tracking_ref  = payload.get('trackingReference')
    is_successful = payload.get('successful', False)
    mpesa_ref     = payload.get('thirdPartyReference', '')
    fail_reason   = payload.get('failReason', '')

    if not tracking_ref:
        return JsonResponse({'status': 'ok'})

    from ..models import WithdrawalRequest
    try:
        withdrawal = WithdrawalRequest.objects.get(tracking_reference=tracking_ref)
    except WithdrawalRequest.DoesNotExist:
        logger.error(f'Withdrawal callback for unknown trackingReference={tracking_ref}')
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
                notify_user(
                    withdrawal.user,
                    'withdrawal_success',
                    amount=withdrawal.amount_kes,
                    mpesa_ref=mpesa_ref,
                    method=withdrawal.method,
                )
            else:
                locked_user = withdrawal.user.__class__.objects.select_for_update().get(
                    id=withdrawal.user.id
                )
                locked_user.wallet_balance += withdrawal.amount_kes
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
                notify_user(
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
