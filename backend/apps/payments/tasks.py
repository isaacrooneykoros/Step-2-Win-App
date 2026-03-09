from celery import shared_task
import logging

logger = logging.getLogger(__name__)


@shared_task
def refresh_pochipay_token():
    """
    Refreshes the PochPay JWT before it expires.
    PochPay tokens expire after 3600s — we refresh every 55 minutes.
    Token is stored only in cache, never in the database.
    """
    from . import pochipay
    try:
        token = pochipay._refresh_token()
        logger.info('PochPay token refreshed via scheduled task')
        return {'status': 'ok', 'token_length': len(token)}
    except Exception as e:
        logger.error(f'Scheduled PochPay token refresh failed: {e}')
        raise


@shared_task
def reconcile_pending_payments():
    """
    Runs every 30 minutes.
    Queries PochPay for any 'pending' transactions older than 15 minutes.
    This is the fallback in case we missed a callback.
    """
    from .models import PaymentTransaction
    from . import pochipay
    from django.utils import timezone
    from datetime import timedelta

    cutoff = timezone.now() - timedelta(minutes=15)
    pending = PaymentTransaction.objects.filter(
        status='pending',
        created_at__lt=cutoff,
    )

    for txn in pending:
        try:
            if txn.type == 'deposit' and txn.order_id:
                result = pochipay.query_collection(txn.order_id)
                _reconcile_deposit(txn, result)

            elif txn.type == 'payout' and txn.tracking_reference:
                result = pochipay.get_disbursement_status(txn.tracking_reference)
                _reconcile_payout(txn, result)

        except Exception as e:
            logger.error(f'Reconciliation failed for txn {txn.id}: {e}')

    from .models import WithdrawalRequest
    from django.db import transaction as db_transaction
    from apps.users.models import User

    pending_withdrawals = WithdrawalRequest.objects.filter(
        status='processing',
        updated_at__lt=timezone.now() - timedelta(minutes=15),
    )

    for withdrawal in pending_withdrawals:
        if not withdrawal.tracking_reference:
            continue
        try:
            result = pochipay.get_disbursement_status(withdrawal.tracking_reference)
            data = result.get('result', {})
            status = data.get('status', '')

            if status == 'Complete':
                with db_transaction.atomic():
                    withdrawal.status = 'completed'
                    withdrawal.mpesa_reference = data.get('thirdPartyReference', '')
                    withdrawal.callback_received_at = timezone.now()
                    withdrawal.save(update_fields=[
                        'status', 'mpesa_reference', 'callback_received_at', 'updated_at'
                    ])
                logger.info(f'Reconciled withdrawal {withdrawal.id} as completed')

            elif status == 'Failed':
                with db_transaction.atomic():
                    user = User.objects.select_for_update().get(id=withdrawal.user_id)
                    user.wallet_balance = user.wallet_balance + withdrawal.amount_kes
                    user.save(update_fields=['wallet_balance', 'updated_at'])

                    withdrawal.status = 'failed'
                    withdrawal.fail_reason = data.get('message', 'Failed')
                    withdrawal.save(update_fields=['status', 'fail_reason', 'updated_at'])
                logger.warning(f'Reconciled withdrawal {withdrawal.id} as failed — refunded')

        except Exception as e:
            logger.error(f'Withdrawal reconciliation error | id={withdrawal.id}: {e}')


def _reconcile_deposit(txn, result):
    """Processes a queried deposit status."""
    from django.db import transaction as db_transaction
    from django.utils import timezone
    from apps.users.models import User

    data = result.get('result', {})
    if not data:
        return

    status = data.get('status', '')
    if status == 'Complete' and data.get('isSuccessful'):
        with db_transaction.atomic():
            user = User.objects.select_for_update().get(id=txn.user_id)
            # Only credit if not already credited (idempotency)
            if txn.status != 'completed':
                user.wallet_balance = user.wallet_balance + txn.amount_kes
                user.save(update_fields=['wallet_balance', 'updated_at'])
                txn.status               = 'completed'
                txn.mpesa_reference      = data.get('mpesaReference', '')
                txn.callback_received_at = timezone.now()
                txn.save(update_fields=['status', 'mpesa_reference',
                                        'callback_received_at', 'updated_at'])
                logger.info(f'Reconciled deposit {txn.order_id} as completed')

    elif status == 'Failed':
        txn.status = 'failed'
        txn.save(update_fields=['status', 'updated_at'])


def _reconcile_payout(txn, result):
    """Processes a queried disbursement status."""
    from django.utils import timezone
    data = result.get('result', {})
    if not data:
        return

    status = data.get('status', '')
    if status == 'Complete':
        txn.status               = 'completed'
        txn.mpesa_reference      = data.get('thirdPartyReference', '')
        txn.callback_received_at = timezone.now()
        txn.save(update_fields=['status', 'mpesa_reference', 'callback_received_at', 'updated_at'])
        logger.info(f'Reconciled payout {txn.tracking_reference} as completed')

    elif status == 'Pending' and data.get('narrationId'):
        # Can be retried
        logger.info(f'Payout {txn.tracking_reference} still pending — narrationId available')

    elif status == 'Failed':
        txn.status = 'failed'
        txn.save(update_fields=['status', 'updated_at'])
