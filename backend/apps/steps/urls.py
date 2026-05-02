from django.urls import path
from . import views
from . import security_endpoints

app_name = 'steps'

urlpatterns = [
    path('sync/', views.sync_health, name='sync_health'),
    path('today/', views.today_health, name='today_health'),
    path('summary/', views.health_summary, name='health_summary'),
    path('history/', views.health_history, name='health_history'),
    path('weekly/', views.weekly_steps, name='weekly_steps'),
    path('day/<str:date_str>/', views.day_detail, name='day_detail'),
    path('sync/hourly/', views.sync_hourly_steps, name='sync_hourly_steps'),
    # Security endpoints
    path('session/start/', security_endpoints.start_step_session, name='session_start'),
    path('session/end/', security_endpoints.end_step_session, name='session_end'),
    path('trust/profile/', security_endpoints.get_user_trust_profile, name='trust_profile'),
    path('policy/active/', security_endpoints.get_active_policy, name='policy_active'),
]
