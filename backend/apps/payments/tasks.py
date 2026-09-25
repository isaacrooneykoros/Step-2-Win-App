import logging
from datetime import timedelta

from celery import shared_task
from django.conf import settings
from django.utils import timezone

from .reconciliation import (ReconciliationThresholds,
                             run_financial_reconciliation)

logger = logging.getLogger(__name__)


@shared_task
def process_unprocessed_callbacks():
    """
    Runs every 5 minutes.
    Processes CallbackLog entries that were logged but not yet processed.
    This handles cases where payment processing failed after logging the webhook.
    """
    from .models import CallbackLog
    from .services import (process_deposit_callback, process_payout_callback,
                           process_withdrawal_callback)

    # Find unprocessed callbacks older than 1 minute
    cutoff = timezone.now() - timedelta(minutes=1)
    unprocessed = CallbackLog.objects.filter(
        processed=False, created_at__lt=cutoff
    ).order_by("created_at")[
        :100
    ]  # Process max 100 per task

    for log in unprocessed:
        try:
            logger.info(
                f"Reprocessing callback {log.id}: {log.type} order={log.order_id}"
            )
            if log.type == "deposit":
                process_deposit_callback(log.raw_payload)
            elif log.type == "payout":
                process_payout_callback(log.raw_payload)
            elif log.type == "withdrawal":
                # Idempotent: re-reads the withdrawal under lock and skips final states.
                process_withdrawal_callback(log.raw_payload)
            else:
                logger.warning(f"Unknown callback type: {log.type}")
                log.processed = True
                log.save(update_fields=["processed"])
        except Exception as e:
            logger.error(f"Callback reprocessing failed {log.id}: {e}")
            # Don't mark as processed - will retry
            continue


@shared_task
def reconcile_pending_payments():
    """
    Runs every 30 minutes.
    Queries IntaSend for any 'pending' transactions older than 15 minutes.
    This is the fallback in case we missed a webhook callback.
    """
    from datetime import timedelta

    from django.utils import timezone

    from . import intasend
    from .models import PaymentTransaction

    cutoff = timezone.now() - timedelta(minutes=15)
    pending = PaymentTransaction.objects.filter(
        status="pending",
        created_at__lt=cutoff,
    )

    for txn in pending:
        try:
            if txn.type == "deposit" and txn.collection_id:
                # Use IntaSend's invoice_id (stored as collection_id) to query status
                result = intasend.query_collection(txn.collection_id)
                _reconcile_deposit(txn, result)

            elif txn.type == "payout" and txn.tracking_reference:
                result = intasend.get_disbursement_status(txn.tracking_reference)
                _reconcile_payout(txn, result)

        except Exception as e:
            logger.error(f"Reconciliation failed for txn {txn.id}: {e}")

    from django.db import transaction as db_transaction

    from apps.users.models import User

    from .models import WithdrawalRequest

    pending_withdrawals = WithdrawalRequest.objects.filter(
        status="processing",
        updated_at__lt=timezone.now() - timedelta(minutes=15),
    )

    for withdrawal in pending_withdrawals:
        if not withdrawal.tracking_reference:
            continue
        try:
            result = intasend.get_disbursement_status(withdrawal.tracking_reference)
            status = result.get("status", "")
            transactions = result.get("transactions", [])
            first_txn = transactions[0] if transactions else {}

            if status == "COMPLETE":
                completed = False
                with db_transaction.atomic():
                    # Re-read under lock: a callback may have settled it (and refunded a
                    # failure) while we were querying the gateway.
                    locked = WithdrawalRequest.objects.select_for_update().get(
                        id=withdrawal.id
                    )
                    if locked.status == "processing":
                        locked.status = "completed"
                        locked.mpesa_reference = first_txn.get("mpesa_reference", "")
                        locked.callback_received_at = timezone.now()
                        locked.save(
                            update_fields=[
                                "status",
                                "mpesa_reference",
                                "callback_received_at",
                                "updated_at",
                            ]
                        )
                        completed = True
                if completed:
                    logger.info(f"Reconciled withdrawal {withdrawal.id} as completed")

            elif status == "FAILED":
                from apps.wallet.models import WalletTransaction

                refunded = False
                with db_transaction.atomic():
                    # Re-read under lock: a payout callback may have already failed and
                    # refunded this withdrawal while we were querying the gateway.
                    locked = WithdrawalRequest.objects.select_for_update().get(
                        id=withdrawal.id
                    )
                    if locked.status == "processing":
                        user = User.objects.select_for_update().get(id=locked.user_id)
                        balance_before = user.wallet_balance
                        user.wallet_balance = user.wallet_balance + locked.amount_kes
                        user.save(update_fields=["wallet_balance", "updated_at"])

                        locked.status = "failed"
                        locked.fail_reason = first_txn.get(
                            "failed_reason", ""
                        ) or result.get("failed_reason", "Failed")
                        locked.save(update_fields=["status", "fail_reason", "updated_at"])

                        WalletTransaction.objects.create(
                            user=user,
                            type="refund",
                            amount=locked.amount_kes,
                            balance_before=balance_before,
                            balance_after=user.wallet_balance,
                            description=f"Withdrawal refund #{locked.id}",
                            reference_id=str(locked.id),
                            metadata={"source": "reconciliation", "reason": locked.fail_reason},
                        )
                        refunded = True
                if refunded:
                    logger.warning(
                        f"Reconciled withdrawal {withdrawal.id} as failed — refunded"
                    )

        except Exception as e:
            logger.error(f"Withdrawal reconciliation error | id={withdrawal.id}: {e}")


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

    state = invoice.get("state", "")
    if state == "COMPLETE":
        from apps.wallet.models import WalletTransaction

        from .models import PaymentTransaction

        with db_transaction.atomic():
            # Re-read under lock so a concurrent deposit callback can't credit twice.
            txn = PaymentTransaction.objects.select_for_update().get(id=txn.id)
            user = User.objects.select_for_update().get(id=txn.user_id)
            # Only credit if not already credited (idempotency)
            if txn.status == "pending":
                balance_before = user.wallet_balance
                user.wallet_balance = user.wallet_balance + txn.amount_kes
                user.save(update_fields=["wallet_balance", "updated_at"])
                mpesa_ref = invoice.get("mpesa_reference", "")
                WalletTransaction.objects.create(
                    user=user,
                    type="deposit",
                    amount=txn.amount_kes,
                    balance_before=balance_before,
                    balance_after=user.wallet_balance,
                    description=f"M-Pesa deposit via {mpesa_ref or 'reconciliation'}",
                    reference_id=txn.order_id,
                    metadata={"payment_gateway": "intasend", "mpesa_reference": mpesa_ref, "source": "reconciliation"},
                )
                txn.status = "completed"
                txn.mpesa_reference = mpesa_ref
                txn.callback_received_at = timezone.now()
                txn.save(
                    update_fields=[
                        "status",
                        "mpesa_reference",
                        "callback_received_at",
                        "updated_at",
                    ]
                )
                logger.info(f"Reconciled deposit {txn.order_id} as completed")

    elif state == "FAILED":
        from .models import PaymentTransaction

        with db_transaction.atomic():
            # Don't overwrite a deposit a callback completed in the meantime.
            txn = PaymentTransaction.objects.select_for_update().get(id=txn.id)
            if txn.status == "pending":
                txn.status = "failed"
                txn.fail_reason = invoice.get("failed_reason", "") or invoice.get(
                    "failed_code", ""
                )
                txn.save(update_fields=["status", "fail_reason", "updated_at"])


def _reconcile_payout(txn, result):
    """
    Processes a queried payout/disbursement status.

    Args:
        txn: PaymentTransaction instance
        result: IntaSend response from get_disbursement_status
                {'tracking_id': '...', 'status': 'COMPLETE|FAILED|PENDING',
                 'transactions': [...]}
    """
    from django.db import transaction as db_transaction
    from django.utils import timezone

    from .models import PaymentTransaction
    from .services import refund_failed_payout

    status = result.get("status", "")
    transactions = result.get("transactions", [])
    first_txn = transactions[0] if transactions else {}
    if status not in ("COMPLETE", "FAILED"):
        return

    with db_transaction.atomic():
        # Re-read under lock and act only on a still-pending payout: the payout callback
        # (or an earlier reconciliation run) may have settled it while we were querying
        # the gateway, and settling it twice would refund a failed payout twice.
        txn = PaymentTransaction.objects.select_for_update().get(id=txn.id)
        if txn.status != "pending":
            return

        if status == "COMPLETE":
            txn.status = "completed"
            txn.mpesa_reference = first_txn.get("mpesa_reference", "")
            txn.callback_received_at = timezone.now()
            txn.save(
                update_fields=[
                    "status",
                    "mpesa_reference",
                    "callback_received_at",
                    "updated_at",
                ]
            )
            logger.info(f"Reconciled payout {txn.tracking_reference} as completed")
        else:
            txn.status = "failed"
            txn.fail_reason = first_txn.get("failed_reason", "") or result.get(
                "failed_reason", ""
            )
            txn.save(update_fields=["status", "fail_reason", "updated_at"])
            refund_failed_payout(txn, txn.fail_reason or "Payout failed")


@shared_task
def reconcile_financial_integrity_task():
    """
    Runs periodic financial integrity checks and emits alerts when thresholds are breached.
    """
    thresholds = ReconciliationThresholds(
        max_stuck_processing=int(getattr(settings, "RECON_MAX_STUCK_PROCESSING", 10)),
        max_unprocessed_callbacks=int(
            getattr(settings, "RECON_MAX_UNPROCESSED_CALLBACKS", 5)
        ),
        max_negative_balance_users=int(
            getattr(settings, "RECON_MAX_NEGATIVE_BALANCE_USERS", 0)
        ),
        max_callback_failure_rate_pct=float(
            getattr(settings, "RECON_MAX_CALLBACK_FAILURE_RATE_PCT", 5.0)
        ),
    )
    return run_financial_reconciliation(thresholds=thresholds, send_alerts=True)
