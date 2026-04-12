from django.urls import path
from . import views

app_name = 'steps'

urlpatterns = [
    path('sync/', views.sync_health, name='sync_health'),
    path('sync/nonce/', views.sync_nonce, name='sync_nonce'),
    path('sync/hourly/', views.sync_hourly_steps, name='sync_hourly_steps'),
    path('today/', views.today_health, name='today_health'),
    path('summary/', views.health_summary, name='health_summary'),
    path('history/', views.health_history, name='health_history'),
    path('weekly/', views.weekly_steps, name='weekly_steps'),
    path('day/<str:date_str>/', views.day_detail, name='day_detail'),
]
