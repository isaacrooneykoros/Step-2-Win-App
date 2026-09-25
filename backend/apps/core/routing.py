from django.urls import path

from apps.core.consumers import AdminEventsConsumer

websocket_urlpatterns = [
    path("ws/admin/events/", AdminEventsConsumer.as_asgi()),
]
