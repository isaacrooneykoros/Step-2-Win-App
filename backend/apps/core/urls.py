from django.urls import path

from apps.core import views

urlpatterns = [
    path("pulse/", views.realtime_pulse, name="admin_realtime_pulse"),
    path("status/", views.realtime_status, name="admin_realtime_status"),
]
