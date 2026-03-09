from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView, SpectacularRedocView
from rest_framework import permissions

urlpatterns = [
    # Admin
    path('admin/', admin.site.urls),
    
    # API endpoints
    path('api/auth/', include('apps.users.urls')),
    path('api/challenges/', include('apps.challenges.urls')),
    path('api/wallet/', include('apps.wallet.urls')),
    path('api/steps/', include('apps.steps.urls')),
    path('api/gamification/', include('apps.gamification.urls')),
    path('api/admin/', include('apps.admin_api.urls')),
    path('api/payments/', include('apps.payments.urls')),
    path('api/legal/', include('apps.legal.urls')),
    
    # API Documentation
    path('api/schema/', SpectacularAPIView.as_view(), name='schema'),
    path('api/docs/', SpectacularSwaggerView.as_view(url_name='schema'), name='swagger-ui'),
    path('api/redoc/', SpectacularRedocView.as_view(url_name='schema'), name='redoc'),
]

# Serve media files in development
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

# Custom admin site configuration
admin.site.site_header = 'Step2Win Administration'
admin.site.site_title = 'Step2Win Admin'
admin.site.index_title = 'Welcome to Step2Win Administration'
