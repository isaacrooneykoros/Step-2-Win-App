from django.urls import include, path
from rest_framework.routers import DefaultRouter

from apps.admin_api import (finance_views, support_views, system_views,
                            trust_views)

from apps.admin_api.views import (AdminBadgeViewSet, AdminChallengeViewSet,
                                  AdminDashboardViewSet,
                                  AdminTransactionViewSet, AdminUserViewSet,
                                  action_flag, admin_login,
                                  admin_notifications, admin_register,
                                  approve_withdrawal, current_admin_profile,
                                  fraud_overview, get_audit_logs,
                                  get_challenge_analytics, get_revenue_report,
                                  get_steps_hourly_breakdown, get_steps_logs,
                                  get_support_admins,
                                  get_support_ticket_detail,
                                  get_support_tickets, get_system_settings,
                                  get_transaction_trends, get_user_retention,
                                  ops_monitoring_dashboard, payments_overview,
                                  reject_withdrawal, reply_support_ticket,
                                  retry_failed_withdrawal, retry_payout,
                                  update_support_ticket,
                                  update_system_settings, withdrawal_queue,
                                  withdrawal_stats)

router = DefaultRouter()
router.register(r"users", AdminUserViewSet, basename="admin-user")
router.register(r"challenges", AdminChallengeViewSet, basename="admin-challenge")
router.register(r"transactions", AdminTransactionViewSet, basename="admin-transaction")
router.register(r"badges", AdminBadgeViewSet, basename="admin-badge")
router.register(r"dashboard", AdminDashboardViewSet, basename="admin-dashboard")

app_name = "admin_api"

urlpatterns = [
    path("auth/login/", admin_login, name="admin-login"),
    path("auth/register/", admin_register, name="admin-register"),
    path("profile/", current_admin_profile, name="admin-profile"),
    path("notifications/", admin_notifications, name="admin-notifications"),
    path("settings/", get_system_settings, name="get-settings"),
    path("settings/update/", update_system_settings, name="update-settings"),
    path("audit-logs/", get_audit_logs, name="audit-logs"),
    path("steps/logs/", get_steps_logs, name="steps-logs"),
    path("steps/hourly/", get_steps_hourly_breakdown, name="steps-hourly"),
    path("reports/revenue/", get_revenue_report, name="revenue-report"),
    path("reports/retention/", get_user_retention, name="user-retention"),
    path(
        "reports/challenge-analytics/",
        get_challenge_analytics,
        name="challenge-analytics",
    ),
    path(
        "reports/transaction-trends/", get_transaction_trends, name="transaction-trends"
    ),
    path("support/tickets/", get_support_tickets, name="support-tickets"),
    path(
        "support/tickets/<int:ticket_id>/",
        get_support_ticket_detail,
        name="support-ticket-detail",
    ),
    path(
        "support/tickets/<int:ticket_id>/reply/",
        reply_support_ticket,
        name="support-ticket-reply",
    ),
    path(
        "support/tickets/<int:ticket_id>/update/",
        update_support_ticket,
        name="support-ticket-update",
    ),
    path("support/admins/", get_support_admins, name="support-admins"),
    # Helpdesk queue + conversation (apps/admin_api/support_views.py)
    path("support/queue/", support_views.support_queue, name="support-queue"),
    path(
        "support/tickets/<int:ticket_id>/conversation/",
        support_views.support_conversation,
        name="support-conversation",
    ),
    path(
        "support/tickets/<int:ticket_id>/tags/",
        support_views.support_ticket_tags,
        name="support-ticket-tags",
    ),
    path("support/tags/", support_views.support_tags, name="support-tags"),
    path("support/tags/<int:tag_id>/", support_views.support_tag_delete, name="support-tag-delete"),
    path("support/templates/", support_views.support_templates, name="support-templates"),
    path(
        "support/templates/<int:template_id>/",
        support_views.support_template_detail,
        name="support-template-detail",
    ),
    path(
        "support/templates/<int:template_id>/used/",
        support_views.support_template_used,
        name="support-template-used",
    ),
    # Settings page context (apps/admin_api/system_views.py)
    path("settings/context/", system_views.settings_context, name="settings-context"),
    path("fraud/", fraud_overview, name="fraud-overview"),
    path("fraud/<int:flag_id>/action/", action_flag, name="fraud-action-flag"),
    path("payments/overview/", payments_overview, name="payments-overview"),
    path("payments/<uuid:txn_id>/retry/", retry_payout, name="retry-payout"),
    path("withdrawals/", withdrawal_queue, name="withdrawal-queue"),
    path("withdrawals/stats/", withdrawal_stats, name="withdrawal-stats"),
    path(
        "withdrawals/<uuid:withdrawal_id>/approve/",
        approve_withdrawal,
        name="approve-withdrawal",
    ),
    path(
        "withdrawals/<uuid:withdrawal_id>/reject/",
        reject_withdrawal,
        name="reject-withdrawal",
    ),
    path(
        "withdrawals/<uuid:withdrawal_id>/retry/",
        retry_failed_withdrawal,
        name="retry-failed-withdrawal",
    ),
    path("monitoring/ops/", ops_monitoring_dashboard, name="ops-monitoring-dashboard"),
    # Read-only finance console endpoints (apps/admin_api/finance_views.py)
    path("finance/withdrawals/", finance_views.finance_withdrawals, name="finance-withdrawals"),
    path(
        "finance/withdrawals/<uuid:withdrawal_id>/",
        finance_views.finance_withdrawal_detail,
        name="finance-withdrawal-detail",
    ),
    path("finance/ledger/", finance_views.finance_ledger, name="finance-ledger"),
    path("finance/ledger/export/", finance_views.finance_ledger_export, name="finance-ledger-export"),
    path("finance/report/", finance_views.finance_report, name="finance-report"),
    path("finance/analytics/", finance_views.finance_analytics, name="finance-analytics"),
    # Trust & safety console (apps/admin_api/trust_views.py)
    path("trust/summary/", trust_views.trust_summary, name="trust-summary"),
    path("trust/cases/", trust_views.trust_cases, name="trust-cases"),
    path("trust/cases/<str:kind>/<str:case_id>/", trust_views.trust_case_detail, name="trust-case-detail"),
    path("trust/flags/<int:flag_id>/action/", trust_views.trust_flag_action, name="trust-flag-action"),
    path("trust/sessions/<uuid:review_id>/decision/", trust_views.trust_session_decision, name="trust-session-decision"),
    path("trust/moderation/users/", trust_views.moderation_users, name="trust-moderation-users"),
    path("trust/moderation/history/", trust_views.moderation_history, name="trust-moderation-history"),
    path("trust/users/<int:user_id>/moderate/", trust_views.moderate_user, name="trust-moderate-user"),
    path("monitoring/ops/history/", trust_views.ops_history, name="ops-monitoring-history"),
    path("", include(router.urls)),
]
