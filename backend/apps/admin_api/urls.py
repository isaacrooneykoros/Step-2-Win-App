from django.urls import path, include
from rest_framework.routers import DefaultRouter
from apps.admin_api.views import (
    AdminUserViewSet,
    AdminChallengeViewSet,
    AdminTransactionViewSet,
    AdminBadgeViewSet,
    AdminDashboardViewSet,
    admin_login,
    admin_register,
    current_admin_profile,
    admin_notifications,
    get_system_settings,
    update_system_settings,
    get_audit_logs,
    get_revenue_report,
    get_user_retention,
    get_challenge_analytics,
    get_transaction_trends,
    get_support_tickets,
    get_support_ticket_detail,
    reply_support_ticket,
    update_support_ticket,
    get_support_admins,
    fraud_overview,
    action_flag,
    payments_overview,
    retry_payout,
    withdrawal_queue,
    withdrawal_stats,
    approve_withdrawal,
    reject_withdrawal,
    retry_failed_withdrawal,
)

router = DefaultRouter()
router.register(r'users', AdminUserViewSet, basename='admin-user')
router.register(r'challenges', AdminChallengeViewSet, basename='admin-challenge')
router.register(r'transactions', AdminTransactionViewSet, basename='admin-transaction')
router.register(r'badges', AdminBadgeViewSet, basename='admin-badge')
router.register(r'dashboard', AdminDashboardViewSet, basename='admin-dashboard')

app_name = 'admin_api'

urlpatterns = [
    path('auth/login/', admin_login, name='admin-login'),
    path('auth/register/', admin_register, name='admin-register'),
    path('profile/', current_admin_profile, name='admin-profile'),
    path('notifications/', admin_notifications, name='admin-notifications'),
    path('settings/', get_system_settings, name='get-settings'),
    path('settings/update/', update_system_settings, name='update-settings'),
    path('audit-logs/', get_audit_logs, name='audit-logs'),
    path('reports/revenue/', get_revenue_report, name='revenue-report'),
    path('reports/retention/', get_user_retention, name='user-retention'),
    path('reports/challenge-analytics/', get_challenge_analytics, name='challenge-analytics'),
    path('reports/transaction-trends/', get_transaction_trends, name='transaction-trends'),
    path('support/tickets/', get_support_tickets, name='support-tickets'),
    path('support/tickets/<int:ticket_id>/', get_support_ticket_detail, name='support-ticket-detail'),
    path('support/tickets/<int:ticket_id>/reply/', reply_support_ticket, name='support-ticket-reply'),
    path('support/tickets/<int:ticket_id>/update/', update_support_ticket, name='support-ticket-update'),
    path('support/admins/', get_support_admins, name='support-admins'),
    path('fraud/', fraud_overview, name='fraud-overview'),
    path('fraud/<int:flag_id>/action/', action_flag, name='fraud-action-flag'),
    path('payments/overview/', payments_overview, name='payments-overview'),
    path('payments/<uuid:txn_id>/retry/', retry_payout, name='retry-payout'),
    path('withdrawals/', withdrawal_queue, name='withdrawal-queue'),
    path('withdrawals/stats/', withdrawal_stats, name='withdrawal-stats'),
    path('withdrawals/<uuid:withdrawal_id>/approve/', approve_withdrawal, name='approve-withdrawal'),
    path('withdrawals/<uuid:withdrawal_id>/reject/', reject_withdrawal, name='reject-withdrawal'),
    path('withdrawals/<uuid:withdrawal_id>/retry/', retry_failed_withdrawal, name='retry-failed-withdrawal'),
    path('', include(router.urls)),
]
