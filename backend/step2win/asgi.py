"""
ASGI config for the step2win project.

Daphne serves this for both HTTP (the full Django stack, middleware included)
and WebSockets. See https://docs.djangoproject.com/en/5.0/howto/deployment/asgi/
"""

import os

from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application
from django.urls import path

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "step2win.settings")

# Initialize Django first so model-dependent consumer imports are safe.
django_asgi_app = get_asgi_application()

from apps.admin_api.consumers import (AdminStepsLiveConsumer,  # noqa: E402
                                      SupportChatConsumer)
from apps.challenges.consumers import ChallengeChatConsumer  # noqa: E402
from apps.core.realtime import hub  # noqa: E402
from apps.core.routing import \
    websocket_urlpatterns as core_websocket_urlpatterns  # noqa: E402
from apps.steps.consumers import StepsSyncConsumer  # noqa: E402
from step2win.consumers import HealthCheckConsumer  # noqa: E402


class RealtimeLoopBinder:
    """
    Binds the admin realtime flusher to the server's event loop on the first
    request or socket (daphne has no lifespan events). A no-op check afterwards.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        hub.bind_loop()
        return await self.app(scope, receive, send)


application = RealtimeLoopBinder(
    ProtocolTypeRouter(
        {
            "http": django_asgi_app,
            "websocket": URLRouter(
                [
                    path("ws/health/", HealthCheckConsumer.as_asgi()),
                    *core_websocket_urlpatterns,
                    path("ws/admin/steps/live/", AdminStepsLiveConsumer.as_asgi()),
                    path(
                        "ws/support/tickets/<int:ticket_id>/",
                        SupportChatConsumer.as_asgi(),
                    ),
                    path(
                        "ws/challenges/<int:challenge_id>/chat/",
                        ChallengeChatConsumer.as_asgi(),
                    ),
                    path("ws/steps/sync/", StepsSyncConsumer.as_asgi()),
                ]
            ),
        }
    )
)
