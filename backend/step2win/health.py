from django.utils import timezone
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework import serializers
from drf_spectacular.utils import extend_schema, inline_serializer


@extend_schema(
    responses={
        200: inline_serializer(
            name='HealthCheckResponse',
            fields={
                'status': serializers.CharField(),
                'service': serializers.CharField(),
                'timestamp': serializers.DateTimeField(),
            },
        )
    }
)
@api_view(['GET'])
@permission_classes([AllowAny])
@throttle_classes([])
def health_check(_request):
    """Simple readiness endpoint for uptime checks and CI smoke tests."""
    return Response({
        'status': 'ok',
        'service': 'step2win-backend',
        'timestamp': timezone.now().isoformat(),
    })
