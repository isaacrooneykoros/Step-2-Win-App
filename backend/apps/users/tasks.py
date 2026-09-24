"""
Celery tasks for user management and security.
"""

import logging
from datetime import timedelta
from decimal import Decimal

from celery import shared_task
from django.conf import settings
from django.core.mail import send_mail
from django.db.models import Count, Q, Sum
from django.utils import timezone

logger = logging.getLogger(__name__)


def _alert_new_non_topup_accounts(suspicious_users, window_start, window_end):
    """Send alert details to logs and configured admin/support emails."""
    lines = [
        (
            f"- id={user.id} username={user.username} balance={user.wallet_balance} "
            f"created_at={user.created_at.isoformat()}"
        )
        for user in suspicious_users
    ]

    message = (
        "Nightly monitor detected newly created accounts with wallet balance "
        "but no completed deposit/payout/refund evidence.\n\n"
        f"Window: {window_start.isoformat()} -> {window_end.isoformat()}\n"
        f"Count: {len(suspicious_users)}\n\n"
        "Accounts:\n" + "\n".join(lines)
    )

    logger.error("NON-TOPUP-FUNDING ALERT\n%s", message)

    recipients = []
    try:
        from apps.admin_api.models import SystemSettings

        system_settings = SystemSettings.load()
        if system_settings.admin_email:
            recipients.append(system_settings.admin_email)
        if system_settings.support_email:
            recipients.append(system_settings.support_email)
    except Exception as exc:
        logger.warning(
            "Could not load SystemSettings emails for funding alert: %s", exc
        )

    if hasattr(settings, "ADMINS"):
        recipients.extend([email for _, email in settings.ADMINS if email])

    recipients = list(dict.fromkeys([r for r in recipients if r]))
    if not recipients:
        logger.warning("No recipient emails configured for non-topup funding alert")
        return

    try:
        send_mail(
            subject=f"[Step2Win] Non-topup funding alert ({len(suspicious_users)} users)",
            message=message,
            from_email=getattr(settings, "DEFAULT_FROM_EMAIL", "noreply@step2win.app"),
            recipient_list=recipients,
            fail_silently=False,
        )
        logger.info("Sent non-topup funding alert email to: %s", recipients)
    except Exception as exc:
        logger.exception("Failed sending non-topup funding alert email: %s", exc)


@shared_task
def monitor_new_non_topup_funded_accounts():
    """
    Runs nightly.
    Alerts when newly created accounts (last 24h) have wallet balance > 0
    without completed top-up evidence.
    """
    from apps.users.models import User

    window_end = timezone.now()
    window_start = window_end - timedelta(days=1)

    users = (
        User.objects.annotate(
            completed_deposits=Count(
                "payment_transactions",
                filter=Q(
                    payment_transactions__type="deposit",
                    payment_transactions__status="completed",
                ),
                distinct=True,
            ),
            completed_payouts=Count(
                "payment_transactions",
                filter=Q(
                    payment_transactions__type="payout",
                    payment_transactions__status="completed",
                ),
                distinct=True,
            ),
            completed_refunds=Count(
                "payment_transactions",
                filter=Q(
                    payment_transactions__type="refund",
                    payment_transactions__status="completed",
                ),
                distinct=True,
            ),
            payout_credits=Count(
                "transactions",
                filter=Q(transactions__type="payout"),
                distinct=True,
            ),
            refund_credits=Count(
                "transactions",
                filter=Q(transactions__type="refund"),
                distinct=True,
            ),
        )
        .filter(
            created_at__gte=window_start,
            created_at__lt=window_end,
            wallet_balance__gt=Decimal("0.00"),
            completed_deposits=0,
            completed_payouts=0,
            completed_refunds=0,
            payout_credits=0,
            refund_credits=0,
        )
        .order_by("created_at")
    )

    suspicious = list(users)
    if not suspicious:
        logger.info("Non-topup funding monitor: no suspicious new accounts in last 24h")
        return {
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "suspicious_count": 0,
            "user_ids": [],
        }

    _alert_new_non_topup_accounts(suspicious, window_start, window_end)

    return {
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "suspicious_count": len(suspicious),
        "user_ids": [u.id for u in suspicious],
    }


@shared_task
def check_wallet_balance_consistency():
    """
    Runs every night at 2 AM UTC.
    Verifies wallet balance is correct and locked_balance adds up.
    Fixes orphaned locked balances and alerts on mismatches.

    Checks:
    1. negative wallet/locked balances (report only)
    2. orphaned locked balances (user not in any pending/active challenge) - released
    3. locked_balance lower than the user's unresolved entries (report only)
    """
    from apps.challenges.models import Challenge, Participant
    from apps.users.models import User

    issues = []
    fixes = []

    # Balance model: challenge entries are debited from wallet_balance on join/create,
    # and locked_balance separately tracks money committed to unresolved challenges
    # (released on payout/refund). So locked_balance > wallet_balance is a normal state
    # (e.g. a user who put most of their balance into a challenge) and must not be "fixed".
    open_statuses = ("pending", "active")

    # Check 1: negative balances are always invalid. Report only — never auto-move money.
    for user in User.objects.filter(
        Q(wallet_balance__lt=0) | Q(locked_balance__lt=0)
    ):
        issues.append(
            f"User {user.username} has a negative balance: "
            f"wallet={user.wallet_balance} locked={user.locked_balance}"
        )

    # Check 2: orphaned locked balances (locked money but no unresolved challenge).
    locked_users = User.objects.filter(locked_balance__gt=Decimal("0.00"))
    for user in locked_users:
        open_participations = Participant.objects.filter(
            user=user, challenge__status__in=open_statuses
        ).count()
        if open_participations == 0:
            released = user.locked_balance
            issues.append(
                f"User {user.username} has locked balance KES {released} but no pending/active challenges"
            )
            # Fix: release the orphaned lock back to the spendable wallet.
            user.wallet_balance += released
            user.locked_balance = Decimal("0.00")
            user.save(update_fields=["wallet_balance", "locked_balance"])
            fixes.append(
                f"Fixed {user.username}: released orphaned locked balance KES {released}"
            )

    # Check 3: locked_balance should cover every unresolved entry. Report only.
    expected_locks = (
        Participant.objects.filter(challenge__status__in=open_statuses)
        .values("user_id", "user__username", "user__locked_balance")
        .annotate(expected=Sum("challenge__entry_fee"))
    )
    for row in expected_locks:
        if row["user__locked_balance"] < row["expected"]:
            issues.append(
                f"User {row['user__username']} has unresolved entries totalling KES {row['expected']} "
                f"but locked_balance={row['user__locked_balance']}"
            )

    log_msg = f"Wallet Check | Issues: {len(issues)} | Fixes: {len(fixes)}"
    if issues:
        logger.warning(f"{log_msg}\nIssues: {issues}")
    if fixes:
        logger.info(f"{log_msg}\nFixes: {fixes}")
    else:
        logger.info(f"{log_msg} - All balances OK")

    return {
        "issues_found": len(issues),
        "fixes_applied": len(fixes),
        "issues": issues,
        "fixes": fixes,
    }


@shared_task
def cleanup_inactive_sessions():
    """
    Runs nightly. Cleans up:
    1. Sessions inactive for more than 30 days
    2. Blacklisted tokens older than 60 days (keeps DB clean)
    """
    from rest_framework_simplejwt.token_blacklist.models import \
        BlacklistedToken

    from apps.users.models import DeviceSession

    # Clean up old inactive sessions
    cutoff_sessions = timezone.now() - timedelta(days=30)
    deleted_sessions, _ = DeviceSession.objects.filter(
        is_active=False,
        last_active_at__lt=cutoff_sessions,
    ).delete()

    # Clean up old blacklisted tokens
    cutoff_tokens = timezone.now() - timedelta(days=60)
    deleted_tokens, _ = BlacklistedToken.objects.filter(
        blacklisted_at__lt=cutoff_tokens
    ).delete()

    logger.info(
        f"Cleanup: {deleted_sessions} old sessions, "
        f"{deleted_tokens} old blacklisted tokens removed"
    )

    return {
        "sessions_removed": deleted_sessions,
        "tokens_removed": deleted_tokens,
    }
