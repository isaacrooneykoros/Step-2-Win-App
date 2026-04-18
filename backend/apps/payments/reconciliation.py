from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import requests
from django.conf import settings
from django.db.models import Count
from django.utils import timezone

from apps.core.idempotency import get_duplicate_rejection_count
from apps.payments.models import CallbackLog, PaymentTransaction, WithdrawalRequest
from apps.steps.models import FraudFlag
from apps.users.models import User

logger = logging.getLogger(__name__)


@dataclass
class ReconciliationThresholds:
    max_stuck_processing: int = 10
    max_unprocessed_callbacks: int = 5
    max_negative_balance_users: int = 0
    max_callback_failure_rate_pct: float = 5.0


SCOPES = [
    'payments_deposit',
    'payments_withdrawal',
    'wallet_deposit',
    'wallet_withdrawal',
]


def _safe_alert(payload: dict[str, Any]) -> None:
    webhook = (os := __import__('os')).getenv('OPS_ALERT_WEBHOOK_URL', '').strip()
    if not webhook:
        return
    try:
        requests.post(webhook, json=payload, timeout=4)
    except Exception as exc:
        logger.warning('Failed to send ops alert webhook: %s', exc)


def run_financial_reconciliation(*, thresholds: ReconciliationThresholds | None = None, send_alerts: bool = True) -> dict[str, Any]:
    thresholds = thresholds or ReconciliationThresholds()
    now = timezone.now()
    since_24h = now - timedelta(hours=24)
    stuck_cutoff = now - timedelta(minutes=15)

    unprocessed_callbacks = CallbackLog.objects.filter(processed=False, created_at__lt=now - timedelta(minutes=5)).count()
    callbacks_24h = CallbackLog.objects.filter(created_at__gte=since_24h)
    callbacks_total_24h = callbacks_24h.count()
    callback_failures_24h = callbacks_24h.filter(processed=False, created_at__lt=now - timedelta(minutes=5)).count()
    callback_failure_rate_pct = (
        (callback_failures_24h / callbacks_total_24h) * 100.0 if callbacks_total_24h else 0.0
    )

    stuck_processing_withdrawals = WithdrawalRequest.objects.filter(
        status='processing', updated_at__lt=stuck_cutoff
    ).count()
    stuck_pending_payments = PaymentTransaction.objects.filter(
        status='pending', updated_at__lt=stuck_cutoff
    ).count()

    negative_balance_users = User.objects.filter(wallet_balance__lt=0).count()

    duplicate_gateway_refs = list(
        PaymentTransaction.objects.filter(status='completed')
        .exclude(mpesa_reference='')
        .values('mpesa_reference')
        .annotate(c=Count('id'))
        .filter(c__gt=1)[:20]
    )

    duplicate_request_rejections_today = {
        scope: get_duplicate_rejection_count(scope)
        for scope in SCOPES
    }

    pending_review = WithdrawalRequest.objects.filter(status='pending_review')
    queue_count = pending_review.count()
    oldest = pending_review.order_by('created_at').first()
    queue_oldest_age_hours = (
        round((now - oldest.created_at).total_seconds() / 3600.0, 2) if oldest else 0.0
    )

    fraud_open_flags = FraudFlag.objects.filter(reviewed=False).count()

    breaches: list[str] = []
    if stuck_processing_withdrawals > thresholds.max_stuck_processing:
        breaches.append(
            f'stuck_processing_withdrawals={stuck_processing_withdrawals} > {thresholds.max_stuck_processing}'
        )
    if unprocessed_callbacks > thresholds.max_unprocessed_callbacks:
        breaches.append(
            f'unprocessed_callbacks={unprocessed_callbacks} > {thresholds.max_unprocessed_callbacks}'
        )
    if negative_balance_users > thresholds.max_negative_balance_users:
        breaches.append(
            f'negative_balance_users={negative_balance_users} > {thresholds.max_negative_balance_users}'
        )
    if callback_failure_rate_pct > thresholds.max_callback_failure_rate_pct:
        breaches.append(
            f'callback_failure_rate_pct={callback_failure_rate_pct:.2f} > {thresholds.max_callback_failure_rate_pct}'
        )
    if duplicate_gateway_refs:
        breaches.append(f'duplicate_gateway_references_detected={len(duplicate_gateway_refs)}')

    result = {
        'timestamp': now.isoformat(),
        'metrics': {
            'callback_total_24h': callbacks_total_24h,
            'callback_failures_24h': callback_failures_24h,
            'callback_failure_rate_pct': round(callback_failure_rate_pct, 2),
            'unprocessed_callbacks': unprocessed_callbacks,
            'stuck_processing_withdrawals': stuck_processing_withdrawals,
            'stuck_pending_payments': stuck_pending_payments,
            'negative_balance_users': negative_balance_users,
            'duplicate_gateway_references': duplicate_gateway_refs,
            'duplicate_request_rejections_today': duplicate_request_rejections_today,
            'withdrawal_queue': {
                'count': queue_count,
                'oldest_age_hours': queue_oldest_age_hours,
            },
            'fraud_open_flags': fraud_open_flags,
        },
        'thresholds': {
            'max_stuck_processing': thresholds.max_stuck_processing,
            'max_unprocessed_callbacks': thresholds.max_unprocessed_callbacks,
            'max_negative_balance_users': thresholds.max_negative_balance_users,
            'max_callback_failure_rate_pct': thresholds.max_callback_failure_rate_pct,
        },
        'breaches': breaches,
        'ok': len(breaches) == 0,
    }

    if breaches:
        logger.error('Financial reconciliation breaches: %s', '; '.join(breaches))
        if send_alerts:
            _safe_alert({
                'event': 'financial_reconciliation_breach',
                'breaches': breaches,
                'metrics': result['metrics'],
                'timestamp': result['timestamp'],
            })
    else:
        logger.info('Financial reconciliation OK')

    return result
