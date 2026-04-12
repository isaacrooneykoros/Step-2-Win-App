from celery import shared_task
import logging

logger = logging.getLogger(__name__)


@shared_task
def reconcile_pending_payments():
    """
    Runs every 30 minutes.
    Queries IntaSend for any 'pending' transactions older than 15 minutes.
    This is the fallback in case we missed a webhook callback.
    """
    from .models import PaymentTransaction
    from . import intasend
    from django.utils import timezone
    from datetime import timedelta

    cutoff = timezone.now() - timedelta(minutes=15)
    pending = PaymentTransaction.objects.filter(
        status='pending',
        created_at__lt=cutoff,
    )

    for txn in pending:
        try:
            if txn.type == 'deposit' and txn.collection_id:
                # Use IntaSend's invoice_id (stored as collection_id) to query status
                result = intasend.query_collection(txn.collection_id)
                _reconcile_deposit(txn, result)

            elif txn.type == 'payout' and txn.tracking_reference:
                result = intasend.get_disbursement_status(txn.tracking_reference)
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
            result = intasend.get_disbursement_status(withdrawal.tracking_reference)
            status = result.get('status', '')
            transactions = result.get('transactions', [])
            first_txn = transactions[0] if transactions else {}

            if status == 'COMPLETE':
                with db_transaction.atomic():
                    withdrawal.status = 'completed'
                    withdrawal.mpesa_reference = first_txn.get('mpesa_reference', '')
                    withdrawal.callback_received_at = timezone.now()
                    withdrawal.save(update_fields=[
                        'status', 'mpesa_reference', 'callback_received_at', 'updated_at'
                    ])
                logger.info(f'Reconciled withdrawal {withdrawal.id} as completed')

            elif status == 'FAILED':
                with db_transaction.atomic():
                    user = User.objects.select_for_update().get(id=withdrawal.user_id)
                    user.wallet_balance = user.wallet_balance + withdrawal.amount_kes
                    user.save(update_fields=['wallet_balance', 'updated_at'])

                    withdrawal.status = 'failed'
                    withdrawal.fail_reason = (
                        first_txn.get('failed_reason', '')
                        or result.get('failed_reason', 'Failed')
                    )
                    withdrawal.save(update_fields=['status', 'fail_reason', 'updated_at'])
                logger.warning(f'Reconciled withdrawal {withdrawal.id} as failed — refunded')

        except Exception as e:
            logger.error(f'Withdrawal reconciliation error | id={withdrawal.id}: {e}')


def _reconcile_deposit(txn, invoice):
    """
    Processes a queried deposit (STK Push) status.

    Args:
        txn: PaymentTransaction instance
        invoice: IntaSend invoice dict from query_collection
                 {'invoice_id': '...', 'state': 'COMPLETE|FAILED|PENDING', ...}
    """
    from django.db import transaction as db_transaction
    from django.utils import timezone
    from apps.users.models import User

    if not invoice:
        return

    state = invoice.get('state', '')
    if state == 'COMPLETE':
        with db_transaction.atomic():
            user = User.objects.select_for_update().get(id=txn.user_id)
            # Only credit if not already credited (idempotency)
            if txn.status != 'completed':
                user.wallet_balance = user.wallet_balance + txn.amount_kes
                user.save(update_fields=['wallet_balance', 'updated_at'])
                txn.status               = 'completed'
                txn.mpesa_reference      = invoice.get('mpesa_reference', '')
                txn.callback_received_at = timezone.now()
                txn.save(update_fields=['status', 'mpesa_reference',
                                        'callback_received_at', 'updated_at'])
                logger.info(f'Reconciled deposit {txn.order_id} as completed')

    elif state == 'FAILED':
        txn.status = 'failed'
        txn.fail_reason = invoice.get('failed_reason', '') or invoice.get('failed_code', '')
        txn.save(update_fields=['status', 'fail_reason', 'updated_at'])


def _reconcile_payout(txn, result):
    """
    Processes a queried payout/disbursement status.

    Args:
        txn: PaymentTransaction instance
        result: IntaSend response from get_disbursement_status
                {'tracking_id': '...', 'status': 'COMPLETE|FAILED|PENDING',
                 'transactions': [...]}
    """
    from django.utils import timezone

    status = result.get('status', '')
    transactions = result.get('transactions', [])
    first_txn = transactions[0] if transactions else {}

    if status == 'COMPLETE':
        txn.status               = 'completed'
        txn.mpesa_reference      = first_txn.get('mpesa_reference', '')
        txn.callback_received_at = timezone.now()
        txn.save(update_fields=['status', 'mpesa_reference', 'callback_received_at', 'updated_at'])
        logger.info(f'Reconciled payout {txn.tracking_reference} as completed')

    elif status == 'FAILED':
        txn.status = 'failed'
        txn.fail_reason = (
            first_txn.get('failed_reason', '')
            or result.get('failed_reason', '')
        )
        txn.save(update_fields=['status', 'fail_reason', 'updated_at'])
