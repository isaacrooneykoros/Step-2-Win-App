from __future__ import annotations

import hashlib
import hmac
import logging
import uuid
from datetime import timedelta
from decimal import Decimal
from typing import Any

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.exceptions import ImproperlyConfigured
from django.db import models, transaction as db_transaction
from django.utils import timezone

from apps.wallet.models import WalletTransaction

from . import intasend
from .models import CallbackLog, PaymentTransaction, WithdrawalRequest

logger = logging.getLogger(__name__)
User = get_user_model()


class PaymentsServiceError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def verify_intasend_signature(request, callback_name: str) -> None:
    secret = (getattr(settings, 'INTASEND_WEBHOOK_SECRET', '') or '').strip()
    if not secret:
        raise ImproperlyConfigured('INTASEND_WEBHOOK_SECRET is not configured; webhook callbacks are disabled.')

    provided_sig = (request.headers.get('X-IntaSend-Signature', '') or '').strip()
    if not provided_sig:
        raise PaymentsServiceError(f'{callback_name}: missing webhook signature', status_code=403)

    if provided_sig.startswith('sha256='):
        provided_sig = provided_sig.split('=', 1)[1].strip()

    expected_sig = hmac.new(secret.encode(), request.body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(provided_sig, expected_sig):
        raise PaymentsServiceError(f'{callback_name}: invalid webhook signature', status_code=403)


def initiate_deposit(user, amount: Decimal, phone_number: str) -> PaymentTransaction:
    amount = Decimal(str(amount))
    try:
        phone_number = intasend.format_phone(phone_number)
    except ValueError as exc:
        raise PaymentsServiceError(str(exc), status_code=400) from exc

    with db_transaction.atomic():
        user.__class__.objects.select_for_update().get(id=user.id)
        recent_pending = PaymentTransaction.objects.select_for_update().filter(
            user=user,
            type='deposit',
            status__in=['initiated', 'pending'],
            created_at__gte=timezone.now() - timedelta(minutes=5),
        ).first()
        if recent_pending:
            raise PaymentsServiceError(
                'You already have a pending deposit. Please wait for it to complete before initiating another.',
                status_code=400,
            )

        order_id = f'DEP-{uuid.uuid4().hex[:20].upper()}'
        tracking_reference = intasend.generate_tracking_reference('DEP')

        txn = PaymentTransaction.objects.create(
            user=user,
            type='deposit',
            status='initiated',
            amount_kes=amount,
            order_id=order_id,
            tracking_reference=tracking_reference,
            phone_number=phone_number,
            narration=f'Step2Win wallet deposit - {user.username}',
        )

    try:
        invoice = intasend.initiate_mpesa_collection(
            order_id=order_id,
            phone_number=phone_number,
            amount=float(amount),
            narration='Step2Win Deposit',
            user_email=getattr(user, 'email', ''),
        )
        txn.collection_id = invoice.get('invoice_id', '')
        txn.status = 'pending'
        txn.save(update_fields=['collection_id', 'status', 'updated_at'])
    except Exception:
        txn.status = 'failed'
        txn.fail_reason = 'Deposit initiation failed'
        txn.save(update_fields=['status', 'fail_reason', 'updated_at'])
        raise

    return txn


def credit_wallet(
    user,
    amount: Decimal,
    *,
    reference_id: str,
    description: str,
    transaction_type: str,
    metadata: dict[str, Any] | None = None,
) -> WalletTransaction:
    amount = Decimal(str(amount))
    reference_id = reference_id or f'WAL-{uuid.uuid4().hex[:16].upper()}'

    with db_transaction.atomic():
        locked_user = user.__class__.objects.select_for_update().get(id=user.id)
        balance_before = locked_user.wallet_balance
        locked_user.wallet_balance = locked_user.wallet_balance + amount
        locked_user.save(update_fields=['wallet_balance', 'updated_at'])

        wallet_txn = WalletTransaction.objects.create(
            user=locked_user,
            type=transaction_type,
            amount=amount,
            balance_before=balance_before,
            balance_after=locked_user.wallet_balance,
            description=description,
            reference_id=reference_id,
            metadata=metadata,
        )

    return wallet_txn


def debit_wallet(
    user,
    amount: Decimal,
    *,
    reference_id: str,
    description: str,
    transaction_type: str,
    metadata: dict[str, Any] | None = None,
) -> WalletTransaction:
    amount = Decimal(str(amount))
    reference_id = reference_id or f'WAL-{uuid.uuid4().hex[:16].upper()}'

    with db_transaction.atomic():
        locked_user = user.__class__.objects.select_for_update().get(id=user.id)
        if locked_user.wallet_balance < amount:
            raise PaymentsServiceError(
                f'Insufficient balance. Available: KES {locked_user.wallet_balance}',
                status_code=400,
            )

        balance_before = locked_user.wallet_balance
        locked_user.wallet_balance = locked_user.wallet_balance - amount
        locked_user.save(update_fields=['wallet_balance', 'updated_at'])

        wallet_txn = WalletTransaction.objects.create(
            user=locked_user,
            type=transaction_type,
            amount=-amount,
            balance_before=balance_before,
            balance_after=locked_user.wallet_balance,
            description=description,
            reference_id=reference_id,
            metadata=metadata,
        )

    return wallet_txn


def request_withdrawal(user, data: dict[str, Any]) -> WithdrawalRequest:
    method = data.get('method')
    amount = Decimal(str(data.get('amount')))

    if method not in ('mpesa', 'bank', 'paybill'):
        raise PaymentsServiceError('method must be one of: mpesa, bank, paybill', status_code=400)

    if method == 'mpesa':
        try:
            phone_number = intasend.format_phone(data.get('phone_number', ''))
        except ValueError as exc:
            raise PaymentsServiceError(str(exc), status_code=400) from exc
    elif method == 'bank':
        bank_code = data.get('bank_code')
        account_number = data.get('account_number')
        if not bank_code or not account_number:
            raise PaymentsServiceError('bank_code and account_number are required for bank withdrawals', status_code=400)
        try:
            banks = intasend.get_available_banks()
            valid_codes = [b.get('bankCode') or b.get('bank_code') for b in banks]
            if bank_code not in valid_codes:
                raise PaymentsServiceError('Invalid bank_code', status_code=400)
            bank_name = next(
                (b.get('name', '') for b in banks if (b.get('bankCode') or b.get('bank_code')) == bank_code),
                '',
            )
        except PaymentsServiceError:
            raise
        except Exception as exc:
            raise PaymentsServiceError('Could not validate bank. Try again.', status_code=502) from exc
    else:
        short_code = data.get('short_code')
        account_number = data.get('account_number')
        is_paybill = bool(data.get('is_paybill', True))
        if not short_code:
            raise PaymentsServiceError('short_code is required for paybill/till', status_code=400)

    max_daily = Decimal(str(getattr(settings, 'MAX_DAILY_WITHDRAWAL', 0)))
    today = timezone.now().date()

    with db_transaction.atomic():
        locked_user = user.__class__.objects.select_for_update().get(id=user.id)

        existing_active = WithdrawalRequest.objects.select_for_update().filter(
            user=user,
            status__in=['pending_review', 'approved', 'processing'],
        ).exists()
        if existing_active:
            raise PaymentsServiceError(
                'You already have an active withdrawal request. Please wait for it to complete.',
                status_code=400,
            )

        if locked_user.wallet_balance < amount:
            raise PaymentsServiceError(
                f'Insufficient balance. Available: KES {locked_user.wallet_balance}',
                status_code=400,
            )

        daily_total = WithdrawalRequest.objects.filter(
            user=user,
            created_at__date=today,
            status__in=['pending_review', 'approved', 'processing', 'completed'],
        ).aggregate(total=models.Sum('amount_kes'))['total'] or Decimal('0')

        if max_daily and daily_total + amount > max_daily:
            remaining = max_daily - daily_total
            raise PaymentsServiceError(
                f'Daily withdrawal limit reached. Remaining today: KES {remaining}',
                status_code=400,
            )

        locked_user.wallet_balance = locked_user.wallet_balance - amount
        locked_user.save(update_fields=['wallet_balance', 'updated_at'])

        withdrawal_data: dict[str, Any] = {
            'user': user,
            'status': 'pending_review',
            'amount_kes': amount,
            'method': method,
            'narration': f'Step2Win withdrawal - {user.username}',
        }

        if method == 'mpesa':
            withdrawal_data['phone_number'] = phone_number
        elif method == 'bank':
            withdrawal_data['bank_code'] = bank_code
            withdrawal_data['bank_name'] = bank_name
            withdrawal_data['account_number'] = account_number
        else:
            withdrawal_data['short_code'] = short_code
            withdrawal_data['account_number'] = account_number or ''
            withdrawal_data['is_paybill'] = is_paybill

        withdrawal = WithdrawalRequest.objects.create(**withdrawal_data)

    return withdrawal


def reject_withdrawal_request(withdrawal: WithdrawalRequest, *, reason: str, reviewer) -> WithdrawalRequest:
    with db_transaction.atomic():
        locked_withdrawal = WithdrawalRequest.objects.select_for_update().get(id=withdrawal.id)
        if locked_withdrawal.status != 'pending_review':
            raise PaymentsServiceError(f'Cannot reject — status is: {locked_withdrawal.status}', status_code=400)

        locked_user = locked_withdrawal.user.__class__.objects.select_for_update().get(id=locked_withdrawal.user_id)
        locked_user.wallet_balance = locked_user.wallet_balance + locked_withdrawal.amount_kes
        locked_user.save(update_fields=['wallet_balance', 'updated_at'])

        locked_withdrawal.status = 'rejected'
        locked_withdrawal.rejection_reason = reason
        locked_withdrawal.reviewed_by = reviewer
        locked_withdrawal.reviewed_at = timezone.now()
        locked_withdrawal.save(update_fields=['status', 'rejection_reason', 'reviewed_by', 'reviewed_at', 'updated_at'])

    return locked_withdrawal


def approve_withdrawal_and_send(withdrawal: WithdrawalRequest, *, reviewer) -> tuple[WithdrawalRequest, str]:
    callback_url = getattr(settings, 'INTASEND_WITHDRAWAL_CALLBACK_URL', '')
    remarks = f'Step2Win withdrawal for {withdrawal.user.username}'
    temp_reference = f'WDR-{uuid.uuid4().hex[:16].upper()}'

    with db_transaction.atomic():
        locked_withdrawal = WithdrawalRequest.objects.select_for_update().get(id=withdrawal.id)
        if locked_withdrawal.status != 'pending_review':
            raise PaymentsServiceError(f'Cannot approve — status is: {locked_withdrawal.status}', status_code=400)

        locked_withdrawal.status = 'approved'
        locked_withdrawal.reviewed_by = reviewer
        locked_withdrawal.reviewed_at = timezone.now()
        locked_withdrawal.save(update_fields=['status', 'reviewed_by', 'reviewed_at', 'updated_at'])

        payout_txn = PaymentTransaction.objects.create(
            user=locked_withdrawal.user,
            type='payout',
            status='pending',
            amount_kes=locked_withdrawal.amount_kes,
            order_id=str(locked_withdrawal.id),
            tracking_reference=temp_reference,
            request_id='',
            phone_number=locked_withdrawal.phone_number or locked_withdrawal.account_number or locked_withdrawal.short_code,
            narration=remarks,
        )

    try:
        if locked_withdrawal.method == 'mpesa':
            tracking_id = intasend.send_withdrawal_to_mobile(
                phone_number=locked_withdrawal.phone_number,
                amount=float(locked_withdrawal.amount_kes),
                remarks=remarks,
                callback_url=callback_url,
            )
        elif locked_withdrawal.method == 'bank':
            tracking_id = intasend.send_withdrawal_to_bank(
                bank_code=locked_withdrawal.bank_code,
                account_number=locked_withdrawal.account_number,
                amount=float(locked_withdrawal.amount_kes),
                remarks=remarks,
                callback_url=callback_url,
            )
        elif locked_withdrawal.method == 'paybill':
            tracking_id = intasend.send_withdrawal_to_paybill(
                short_code=locked_withdrawal.short_code,
                account_number=locked_withdrawal.account_number or None,
                amount=float(locked_withdrawal.amount_kes),
                remarks=remarks,
                callback_url=callback_url,
            )
        else:
            raise PaymentsServiceError(f'Unknown withdrawal method: {locked_withdrawal.method}', status_code=400)
    except Exception as exc:
        with db_transaction.atomic():
            locked_user = locked_withdrawal.user.__class__.objects.select_for_update().get(id=locked_withdrawal.user_id)
            locked_user.wallet_balance = locked_user.wallet_balance + locked_withdrawal.amount_kes
            locked_user.save(update_fields=['wallet_balance', 'updated_at'])

            locked_withdrawal.status = 'failed'
            locked_withdrawal.fail_reason = f'IntaSend error: {exc}'
            locked_withdrawal.save(update_fields=['status', 'fail_reason', 'updated_at'])

            payout_txn.status = 'failed'
            payout_txn.fail_reason = str(exc)
            payout_txn.save(update_fields=['status', 'fail_reason', 'updated_at'])

        raise

    tracking_id = tracking_id or temp_reference

    with db_transaction.atomic():
        locked_withdrawal = WithdrawalRequest.objects.select_for_update().get(id=withdrawal.id)
        locked_withdrawal.tracking_reference = tracking_id
        locked_withdrawal.request_id = tracking_id
        locked_withdrawal.status = 'processing'
        locked_withdrawal.save(update_fields=['tracking_reference', 'request_id', 'status', 'updated_at'])

        payout_txn.tracking_reference = tracking_id
        payout_txn.request_id = tracking_id
        payout_txn.save(update_fields=['tracking_reference', 'request_id', 'updated_at'])

    return locked_withdrawal, tracking_id


def log_callback(callback_type: str, payload: dict[str, Any], order_id: str = '') -> CallbackLog:
    payload_text = str(payload)
    try:
        import json
        payload_text = json.dumps(payload, sort_keys=True, separators=(',', ':'))
    except Exception:
        pass

    payload_hash = hashlib.sha256(payload_text.encode('utf-8')).hexdigest()
    log, _ = CallbackLog.objects.get_or_create(
        type=callback_type,
        order_id=order_id,
        payload_hash=payload_hash,
        defaults={
            'raw_payload': payload,
        },
    )
    return log


def process_deposit_callback(payload: dict[str, Any]) -> None:
    invoice = payload.get('invoice', {})
    order_id = invoice.get('api_ref', '')
    state = invoice.get('state', '')
    mpesa_ref = invoice.get('mpesa_reference', '')
    fail_reason = invoice.get('failed_reason', '') or invoice.get('failed_code', '')

    log = log_callback('deposit', payload, order_id)
    if not order_id:
        return

    with db_transaction.atomic():
        txn = PaymentTransaction.objects.select_for_update().get(order_id=order_id, type='deposit')
        if txn.status in ('completed', 'failed', 'cancelled'):
            log.processed = True
            log.save(update_fields=['processed'])
            return

        if state == 'COMPLETE':
            locked_user = txn.user.__class__.objects.select_for_update().get(id=txn.user_id)
            balance_before = locked_user.wallet_balance
            locked_user.wallet_balance = locked_user.wallet_balance + txn.amount_kes
            locked_user.save(update_fields=['wallet_balance', 'updated_at'])

            txn.status = 'completed'
            txn.mpesa_reference = mpesa_ref
            txn.callback_received_at = timezone.now()
            txn.save(update_fields=['status', 'mpesa_reference', 'callback_received_at', 'updated_at'])

            WalletTransaction.objects.create(
                user=locked_user,
                type='deposit',
                amount=txn.amount_kes,
                balance_before=balance_before,
                balance_after=locked_user.wallet_balance,
                description=f'M-Pesa deposit via {mpesa_ref}',
                reference_id=order_id,
                metadata={'payment_gateway': 'intasend', 'mpesa_reference': mpesa_ref},
            )
        else:
            txn.status = 'failed' if fail_reason else 'cancelled'
            txn.fail_reason = fail_reason
            txn.callback_received_at = timezone.now()
            txn.save(update_fields=['status', 'fail_reason', 'callback_received_at', 'updated_at'])

        log.processed = True
        log.save(update_fields=['processed'])


def _refund_linked_withdrawal(txn: PaymentTransaction, fail_reason: str) -> None:
    withdrawal = WithdrawalRequest.objects.filter(id=txn.order_id).first()
    if withdrawal and withdrawal.status not in ('failed', 'completed', 'rejected', 'cancelled'):
        locked_user = withdrawal.user.__class__.objects.select_for_update().get(id=withdrawal.user_id)
        balance_before = locked_user.wallet_balance
        locked_user.wallet_balance = locked_user.wallet_balance + withdrawal.amount_kes
        locked_user.save(update_fields=['wallet_balance', 'updated_at'])

        withdrawal.status = 'failed'
        withdrawal.fail_reason = fail_reason
        withdrawal.save(update_fields=['status', 'fail_reason', 'updated_at'])

        WalletTransaction.objects.create(
            user=locked_user,
            type='refund',
            amount=withdrawal.amount_kes,
            balance_before=balance_before,
            balance_after=locked_user.wallet_balance,
            description=f'Withdrawal refund #{withdrawal.id}',
            reference_id=str(withdrawal.id),
            metadata={'source': 'payout_failure', 'reason': fail_reason},
        )
        return

    locked_user = txn.user.__class__.objects.select_for_update().get(id=txn.user_id)
    balance_before = locked_user.wallet_balance
    locked_user.wallet_balance = locked_user.wallet_balance + txn.amount_kes
    locked_user.save(update_fields=['wallet_balance', 'updated_at'])

    WalletTransaction.objects.create(
        user=locked_user,
        type='refund',
        amount=txn.amount_kes,
        balance_before=balance_before,
        balance_after=locked_user.wallet_balance,
        description=f'Payout refund #{txn.order_id}',
        reference_id=txn.order_id,
        metadata={'source': 'payout_failure', 'reason': fail_reason},
    )


def refund_failed_payout(txn: PaymentTransaction, fail_reason: str) -> None:
    with db_transaction.atomic():
        _refund_linked_withdrawal(txn, fail_reason)


def process_payout_callback(payload: dict[str, Any]) -> None:
    tracking_ref = payload.get('tracking_id', '')
    status_str = payload.get('status', '')
    transactions = payload.get('transactions', [])
    first_txn = transactions[0] if transactions else {}
    mpesa_ref = first_txn.get('mpesa_reference', '')
    fail_reason = first_txn.get('failed_reason', '') or payload.get('failed_reason', '')

    log = log_callback('payout', payload, tracking_ref)
    if not tracking_ref:
        return

    with db_transaction.atomic():
        txn = PaymentTransaction.objects.select_for_update().get(tracking_reference=tracking_ref, type='payout')
        if txn.status in ('completed', 'failed'):
            log.processed = True
            log.save(update_fields=['processed'])
            return

        if status_str == 'COMPLETE':
            txn.status = 'completed'
            txn.mpesa_reference = mpesa_ref
            txn.callback_received_at = timezone.now()
            txn.save(update_fields=['status', 'mpesa_reference', 'callback_received_at', 'updated_at'])

            withdrawal = WithdrawalRequest.objects.filter(id=txn.order_id).first()
            if withdrawal and withdrawal.status == 'processing':
                withdrawal.status = 'completed'
                withdrawal.mpesa_reference = mpesa_ref
                withdrawal.callback_received_at = timezone.now()
                withdrawal.save(update_fields=['status', 'mpesa_reference', 'callback_received_at', 'updated_at'])
        else:
            txn.status = 'failed'
            txn.fail_reason = fail_reason
            txn.callback_received_at = timezone.now()
            txn.save(update_fields=['status', 'fail_reason', 'callback_received_at', 'updated_at'])
            _refund_linked_withdrawal(txn, fail_reason or 'Payout failed')

        log.processed = True
        log.save(update_fields=['processed'])


def process_withdrawal_callback(payload: dict[str, Any]) -> None:
    tracking_ref = payload.get('tracking_id', '')
    status_str = payload.get('status', '')
    transactions = payload.get('transactions', [])
    first_txn = transactions[0] if transactions else {}
    mpesa_ref = first_txn.get('mpesa_reference', '')
    fail_reason = first_txn.get('failed_reason', '') or payload.get('failed_reason', '')

    log = log_callback('withdrawal', payload, tracking_ref)
    if not tracking_ref:
        return

    with db_transaction.atomic():
        withdrawal = WithdrawalRequest.objects.select_for_update().get(tracking_reference=tracking_ref)
        if withdrawal.status in ('completed', 'failed', 'rejected', 'cancelled'):
            log.processed = True
            log.save(update_fields=['processed'])
            return

        if status_str == 'COMPLETE':
            withdrawal.status = 'completed'
            withdrawal.mpesa_reference = mpesa_ref
            withdrawal.callback_received_at = timezone.now()
            withdrawal.save(update_fields=['status', 'mpesa_reference', 'callback_received_at', 'updated_at'])
        else:
            locked_user = withdrawal.user.__class__.objects.select_for_update().get(id=withdrawal.user_id)
            balance_before = locked_user.wallet_balance
            locked_user.wallet_balance = locked_user.wallet_balance + withdrawal.amount_kes
            locked_user.save(update_fields=['wallet_balance', 'updated_at'])

            withdrawal.status = 'failed'
            withdrawal.fail_reason = fail_reason
            withdrawal.callback_received_at = timezone.now()
            withdrawal.save(update_fields=['status', 'fail_reason', 'callback_received_at', 'updated_at'])

            WalletTransaction.objects.create(
                user=locked_user,
                type='refund',
                amount=withdrawal.amount_kes,
                balance_before=balance_before,
                balance_after=locked_user.wallet_balance,
                description=f'Withdrawal refund #{withdrawal.id}',
                reference_id=str(withdrawal.id),
                metadata={'source': 'withdrawal_callback', 'reason': fail_reason},
            )

        log.processed = True
        log.save(update_fields=['processed'])