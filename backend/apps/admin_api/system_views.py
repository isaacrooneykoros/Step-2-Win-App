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
    "max_challenge_participants": "Challenge creation and rematch validation (size limit for new challenges) and the app's create form",
    "min_challenge_entry_fee": "Challenge creation validation (whole KES) and the app's entry amount field and quick picks",
    "max_challenge_entry_fee": "Challenge creation validation (whole KES) and the app's entry amount field and quick picks",
    "challenge_approval_required": "New public challenges and rematches wait in Challenges > Awaiting approval, hidden from the lobby until approved; rejecting refunds entries. Private challenges never need approval",
    "xp_per_step": "XP awarded on each step sync for the day's accepted steps (once per step, re-syncs only add the difference)",
    "daily_goal_bonus_xp": "One-off XP bonus the first time a day's accepted steps reach the customer's daily goal",
    "email_notifications_enabled": "Master switch for notification emails (currently the M-Pesa funding alert email); password reset and other requested emails always send",
    "admin_email": "Recipient of M-Pesa funding alerts",
    "support_email": "Recipient of M-Pesa funding alerts; shown in the customer app's config",
    # apps/admin_api/platform.py
    "minimum_withdrawal_amount": "Withdrawal request service and the app's withdraw form",
    "withdrawal_processing_time": "The app's withdraw form and the withdrawal-submitted message",
    "withdrawals_enabled": "Withdrawal request endpoints (app and payments API)",
    "registrations_enabled": "Sign-up endpoints (email and Google)",
    "challenges_enabled": "Create-challenge and rematch endpoints",
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
    # apps/challenges/payout_holds.py
    "payout_holds_enabled": "Challenge settlement: risky winners' payouts wait in Finance > Payout reviews instead of being credited",
    "payout_hold_trust_score_max": "Challenge settlement: a winner at or below this trust score is held for review",
    "payout_hold_large_win_kes": "Challenge settlement: payouts at or above this are held when the winner has open medium+ flags in the challenge window",
    # apps/steps/integrity.py + apps/steps/evidence.py
    "device_integrity_policy": "Step sync and walks: with enforce, steps from sessions that failed Play Integrity count for goals only, not toward challenges",
    # apps/steps/health_sources.py
    "health_trusted_origins": "Health Connect / Apple Health uploads: only these apps' steps and workouts can count (manual entries never do)",
    # apps/admin_api/business_rules.py (console value, else the server value)
    "rank_payouts_enabled": "Create-challenge form and validation: whether winner-takes-all / top-3 can be picked (existing challenges keep their rule)",
    "paid_challenge_min_trust_score": "Creating a paid challenge: the creator's trust score must be at least this",
    "paid_challenge_min_joined": "Creating a paid challenge: challenges the creator must have joined first",
    "max_locked_balance_percent": "Creating and joining challenges: most of a customer's funds that can be locked in entries",
    "step_money_requires_evidence": "Step sync: only evidence-backed steps count toward challenge money (goals, streaks and XP always use every credited step)",
    "step_evidence_cutover_date": "Step sync: days before this date keep full challenge credit",
    "play_integrity_accept_basic": "Play Integrity verdicts: whether basic-integrity phones count as verified",
    "risk_ml_hold_threshold": "Shadow risk model reports (precision/recall at this score). Nothing is held automatically",
    "min_deposit_kes": "Deposit endpoints (app wallet and payments API)",
    "max_deposit_kes": "Deposit endpoints (app wallet and payments API)",
    "max_withdrawal_kes": "Withdrawal request validation (app and payments API)",
    "max_daily_withdrawal_kes": "Withdrawal requests: total a customer can request per day",
    "max_withdrawals_per_day": "Withdrawal requests: count per rolling 24 hours",
    "max_withdrawals_per_hour": "Withdrawal requests: count per rolling hour",
    "min_seconds_between_withdrawals": "Withdrawal requests: minimum gap between two requests",
    "recon_max_stuck_processing": "Financial reconciliation job and Ops monitoring alerts",
    "recon_max_unprocessed_callbacks": "Financial reconciliation job and Ops monitoring alerts",
    "recon_max_negative_balance_users": "Financial reconciliation job and Ops monitoring alerts",
    "recon_max_callback_failure_rate_pct": "Financial reconciliation job and Ops monitoring alerts",
    "drift_lookback_hours": "Anti-cheat drift monitor job and Ops monitoring alerts",
    "drift_min_samples": "Anti-cheat drift monitor job and Ops monitoring alerts",
    "drift_per_sample_alert_pct": "Anti-cheat drift monitor job and Ops monitoring alerts",
    "drift_max_avg_abs_delta_pct": "Anti-cheat drift monitor job and Ops monitoring alerts",
    "drift_max_high_drift_ratio_pct": "Anti-cheat drift monitor job and Ops monitoring alerts",
    "drift_max_review_mismatch_ratio_pct": "Anti-cheat drift monitor job and Ops monitoring alerts",
}


def _setting(name, default=None):
    return getattr(django_settings, name, default)


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def settings_context(request):
    history = AuditLog.objects.filter(resource_type="settings").order_by("-created_at")[:25]
    staff = User.objects.filter(is_staff=True).order_by("-is_superuser", "username")
    from apps.admin_api.business_rules import describe

    return Response(
        {
            "enforced_by": ENFORCED_BY,
            # Per console rule: effective value, source (console/server), server value and
            # whether the server value is a ceiling (cap) or floor. See business_rules.py.
            "rules": describe(),
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
