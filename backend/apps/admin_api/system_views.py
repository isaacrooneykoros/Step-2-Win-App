"""
Read-only context for the admin console's System settings page.

The editable settings live in SystemSettings (GET/POST /api/admin/settings/).
This endpoint adds what the page needs to explain a change before it is saved:
server-side limits that are fixed in configuration, which stored settings the
backend actually reads, how many challenges a fee change would reach, the
change history from the audit log, and the staff accounts.
Nothing here writes data.
"""

from django.conf import settings as django_settings
from django.contrib.auth import get_user_model
from drf_spectacular.utils import OpenApiTypes, extend_schema
from rest_framework import permissions
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.admin_api.models import AuditLog
from apps.admin_api.views import IsAdminUser
from apps.challenges.models import Challenge

User = get_user_model()

ADMIN = [permissions.IsAuthenticated, IsAdminUser]

# Where each stored setting is read by the backend today (verified by grep of
# SystemSettings.load() call sites). Keys not listed are stored but not enforced.
ENFORCED_BY = {
    "platform_fee_percentage": "Challenge settlement (platform fee on every pool) and the customer app's challenge config",
    "challenge_milestones": "Challenge creation validation and the customer app's milestone picker",
    "min_challenge_milestone": "Challenge creation validation and the customer app's challenge config",
    "max_challenge_milestone": "Challenge creation validation and the customer app's challenge config",
    "max_challenge_participants": "Shown in the customer app's challenge config",
    "admin_email": "Recipient of M-Pesa funding alerts",
    "support_email": "Recipient of M-Pesa funding alerts; shown in the customer app's config",
    # apps/admin_api/platform.py
    "minimum_withdrawal_amount": "Withdrawal request service and the app's withdraw form",
    "withdrawal_processing_time": "The app's withdraw form",
    "withdrawals_enabled": "Withdrawal request endpoints (app and payments API)",
    "registrations_enabled": "Sign-up endpoints (email and Google)",
    "challenges_enabled": "Create-challenge and rematch endpoints",
    "referral_program_enabled": "Exposed to the app's config only; there is no referral feature in the app yet",
    "maintenance_mode": "Every customer API request (maintenance middleware)",
    "maintenance_message": "The customer app's maintenance screen",
    # apps/admin_api/support_rules.py
    "support_sla_urgent_hours": "Support queue colouring, Overdue view and escalation",
    "support_sla_high_hours": "Support queue colouring, Overdue view and escalation",
    "support_sla_medium_hours": "Support queue colouring, Overdue view and escalation",
    "support_sla_low_hours": "Support queue colouring, Overdue view and escalation",
    "support_auto_assign_mode": "Assigns each new ticket when it is created",
    "support_agent_ids": "Round-robin pool for new tickets",
    "support_category_assignees": "Category rule for new tickets (falls back to the round-robin pool)",
    "support_escalation_enabled": "Escalation job every 15 minutes (Celery beat)",
    "support_escalation_raise_priority": "Escalation job raises priority one level",
}


def _setting(name, default=None):
    return getattr(django_settings, name, default)


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def settings_context(request):
    history = AuditLog.objects.filter(resource_type="settings").order_by("-created_at")[:25]
    staff = User.objects.filter(is_staff=True).order_by("-is_superuser", "username")
    return Response(
        {
            "enforced_by": ENFORCED_BY,
            "impact": {
                "active_challenges": Challenge.objects.filter(status="active").count(),
                "pending_challenges": Challenge.objects.filter(status="pending").count(),
            },
            "server_limits": {
                "payments": {
                    "min_deposit_kes": _setting("MIN_DEPOSIT_KES"),
                    "max_deposit_kes": _setting("MAX_DEPOSIT_KES"),
                    "min_withdrawal_kes": _setting("MIN_WITHDRAWAL_KES"),
                    "max_withdrawal_kes": _setting("MAX_WITHDRAWAL_KES"),
                    "max_daily_withdrawal_amount_kes": _setting("MAX_DAILY_WITHDRAWAL_AMOUNT_KES"),
                    "max_withdrawals_per_day": _setting("MAX_WITHDRAWALS_PER_DAY"),
                    "max_withdrawals_per_hour": _setting("MAX_WITHDRAWALS_PER_HOUR"),
                    "min_seconds_between_withdrawals": _setting("MIN_SECONDS_BETWEEN_WITHDRAWALS"),
                    "withdrawal_fee_kes": _setting("WITHDRAWAL_FEE_KES"),
                },
                "challenges": {
                    "min_trust_score_for_paid_challenge": _setting("MIN_TRUST_SCORE_FOR_PAID_CHALLENGE"),
                    "min_challenges_joined_to_create_paid": _setting("MIN_CHALLENGES_JOINED_TO_CREATE_PAID_CHALLENGE"),
                },
                "anti_cheat": {
                    "v2_enabled": _setting("STEP_ANTICHEAT_V2_ENABLED"),
                    "v2_shadow_mode": _setting("STEP_ANTICHEAT_V2_SHADOW_MODE"),
                    "v2_version": _setting("STEP_ANTICHEAT_V2_VERSION"),
                    "suspicious_steps_per_min": _setting("ANTICHEAT_V2_SUSPICIOUS_STEPS_PER_MIN"),
                    "impossible_steps_per_min": _setting("ANTICHEAT_V2_IMPOSSIBLE_STEPS_PER_MIN"),
                    "suspicious_cadence_spm": _setting("ANTICHEAT_V2_SUSPICIOUS_CADENCE_SPM"),
                    "impossible_cadence_spm": _setting("ANTICHEAT_V2_IMPOSSIBLE_CADENCE_SPM"),
                    "review_risk": _setting("ANTICHEAT_V2_REVIEW_RISK"),
                    "payout_hold_risk": _setting("ANTICHEAT_V2_PAYOUT_HOLD_RISK"),
                    "reject_risk": _setting("ANTICHEAT_V2_REJECT_RISK"),
                },
            },
            "history": [
                {
                    "id": log.id,
                    "admin_username": log.admin_username,
                    "description": log.description,
                    "changes": log.changes,
                    "created_at": log.created_at,
                }
                for log in history
            ],
            "staff": [
                {
                    "id": u.id,
                    "username": u.username,
                    "email": u.email,
                    "is_superuser": u.is_superuser,
                    "is_active": u.is_active,
                    "last_login": u.last_login,
                    "date_joined": u.date_joined,
                }
                for u in staff
            ],
        }
    )
