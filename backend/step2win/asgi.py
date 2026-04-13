"""
ASGI config for step2win project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/5.0/howto/deployment/asgi/
"""

import os

from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application
from django.urls import path

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'step2win.settings')

# Initialize Django first so model-dependent consumer imports are safe.
django_asgi_app = get_asgi_application()

from apps.admin_api.consumers import SupportChatConsumer
from apps.challenges.consumers import ChallengeChatConsumer
from apps.steps.consumers import StepsSyncConsumer
from step2win.consumers import HealthCheckConsumer

application = ProtocolTypeRouter({
	'http': django_asgi_app,
	'websocket': URLRouter([
		path('ws/health/', HealthCheckConsumer.as_asgi()),
		path('ws/support/tickets/<int:ticket_id>/', SupportChatConsumer.as_asgi()),
		path('ws/challenges/<int:challenge_id>/chat/', ChallengeChatConsumer.as_asgi()),
		path('ws/steps/sync/', StepsSyncConsumer.as_asgi()),
	]),
})
