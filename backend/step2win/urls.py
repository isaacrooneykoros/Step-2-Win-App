from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from django.views.generic import RedirectView
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView, SpectacularRedocView
from rest_framework import permissions
from step2win.health import health_check

urlpatterns = [
    # Root — redirect to the health-check so opening the site shows something useful
    path('', RedirectView.as_view(url='/api/health/', permanent=False)),

    # Admin — URL is obscured via DJANGO_ADMIN_URL env var (default: admin-s2w-secure/)
    path(settings.ADMIN_URL, admin.site.urls),

    # API endpoints
    path('api/auth/', include('apps.users.urls')),
    path('api/challenges/', include('apps.challenges.urls')),
    path('api/wallet/', include('apps.wallet.urls')),
    path('api/steps/', include('apps.steps.urls')),
    path('api/gamification/', include('apps.gamification.urls')),
    path('api/admin/', include('apps.admin_api.urls')),
    path('api/payments/', include('apps.payments.urls')),
    path('api/legal/', include('apps.legal.urls')),
    path('api/health/', health_check, name='health_check'),
]

# OpenAPI docs — only available in DEBUG mode, never in production
if settings.DEBUG:
    urlpatterns += [
        path('api/schema/', SpectacularAPIView.as_view(), name='schema'),
        path('api/docs/',   SpectacularSwaggerView.as_view(url_name='schema'), name='swagger-ui'),
        path('api/redoc/',  SpectacularRedocView.as_view(url_name='schema'), name='redoc'),
    ]

# Serve media files (needed for profile image previews in hosted environments)
urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

# Custom admin site configuration
admin.site.site_header = 'Step2Win Administration'
admin.site.site_title  = 'Step2Win Admin'
admin.site.index_title = 'Welcome to Step2Win Administration'
