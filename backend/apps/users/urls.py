from django.urls import path
from rest_framework_simplejwt.views import TokenRefreshView
from . import views
from . import auth_views

app_name = 'users'

urlpatterns = [
    # Auth endpoints with device session tracking
    path('register/', views.register, name='register'),
    path('login/', auth_views.CustomLoginView.as_view(), name='login'),
    path('google/', views.google_auth, name='google_auth'),
    path('logout/', auth_views.CustomLogoutView.as_view(), name='logout'),
    path('refresh/', auth_views.CustomRefreshView.as_view(), name='token_refresh'),
    path('change-password/', auth_views.CustomChangePasswordView.as_view(), name='change_password'),
    
    # Device session management
    path('sessions/', auth_views.ActiveSessionsView.as_view(), name='active_sessions'),
    path('sessions/<uuid:session_id>/revoke/', auth_views.RevokeSessionView.as_view(), name='revoke_session'),
    path('sessions/revoke-all/', auth_views.RevokeAllSessionsView.as_view(), name='revoke_all_sessions'),
    
    # User profile and settings
    path('profile/', views.ProfileView.as_view(), name='profile'),
    path('goal/', views.update_daily_goal, name='update_daily_goal'),
    path('bind-device/', views.bind_device, name='bind_device'),
    path('device-status/', views.device_status, name='device_status'),
    path('stats/', views.user_stats, name='user_stats'),
    
    # Support tickets
    path('support/tickets/', views.my_support_tickets, name='my_support_tickets'),
    path('support/tickets/create/', views.create_support_ticket, name='create_support_ticket'),
    path('support/tickets/<int:ticket_id>/', views.my_support_ticket_detail, name='my_support_ticket_detail'),
    path('support/tickets/<int:ticket_id>/reply/', views.reply_support_ticket, name='reply_support_ticket'),
    path('support/tickets/<int:ticket_id>/status/', views.update_ticket_status, name='update_ticket_status'),
]
