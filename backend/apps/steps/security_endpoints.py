"""
Step2Win Security Endpoints - Session management, trust profiles, and anti-cheat policy.
Part of the production security hardening implementation.
"""

import logging
from datetime import timedelta
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework import status, serializers
from django.utils import timezone
from django.db import transaction

from .models import (
    DeviceRegistration,
    StepSession,
    StepSyncEvent,
    AntiCheatPolicy,
    UserTrustProfile,
    SuspiciousSessionReview,
)
from .serializers import (
    StepSessionStartSerializer,
    StepSessionStartResponseSerializer,
    StepSessionEndSerializer,
    StepSessionEndResponseSerializer,
    UserTrustProfileSerializer,
    AntiCheatPolicyPublicSerializer,
)
from .security import (
    create_session_token,
    hash_session_token,
    verify_session_token,
    get_or_create_user_trust_profile,
    get_active_policy_version,
    get_trust_reward_modifier,
)
from .anti_cheat import finalize_step_session

logger = logging.getLogger(__name__)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def start_step_session(request):
    """
    Start a new step-syncing session.
    
    Returns session token, nonce, and expiration time.
    This endpoint initiates a challenge-response session for replay protection.
    
    Request:
    {
      "device_id": "android-device-id",
      "platform": "android",
      "app_version": "1.0.0",
      "ml_model_version": "shakewalk-logreg-v1"
    }
    
    Response:
    {
      "session_id": "uuid",
      "session_token": "opaque-token",
      "server_nonce": "random-nonce",
      "expires_at": "2026-05-02T20:00:00Z",
      "sequence_start": 1,
      "policy_version": "anti-cheat-policy-v1"
    }
    """
    serializer = StepSessionStartSerializer(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    
    device_id = serializer.validated_data['device_id']
    platform = serializer.validated_data['platform']
    app_version = serializer.validated_data.get('app_version')
    ml_model_version = serializer.validated_data.get('ml_model_version')
    
    try:
        with transaction.atomic():
            # Register or update device
            device, created = DeviceRegistration.objects.get_or_create(
                user=request.user,
                device_id=device_id,
                defaults={
                    'platform': platform,
                    'app_version': app_version,
                    'trust_level': 'new',
                }
            )
            
            # Update device info if provided
            device.platform = platform
            if app_version:
                device.app_version = app_version
            device.last_seen_at = timezone.now()
            device.save(update_fields=['platform', 'app_version', 'last_seen_at', 'updated_at'])
            
            # Create new session
            session_token = create_session_token()
            session_token_hash = hash_session_token(session_token)
            server_nonce = create_session_token(length=16)
            
            session = StepSession.objects.create(
                user=request.user,
                device=device,
                session_token_hash=session_token_hash,
                server_nonce=server_nonce,
                expires_at=timezone.now() + timedelta(hours=12),
                policy_version=get_active_policy_version(),
                ml_model_version=ml_model_version,
            )
            
            # Get policy version
            policy_version = session.policy_version
            
        # Return session details (token only returned once)
        response_data = {
            'session_id': str(session.id),
            'session_token': session_token,  # Only returned now
            'server_nonce': server_nonce,
            'expires_at': session.expires_at.isoformat(),
            'sequence_start': 1,
            'policy_version': policy_version,
        }
        
        return Response(response_data, status=status.HTTP_201_CREATED)
    
    except Exception as e:
        logger.exception(f"Error starting session for user {request.user.id}: {e}")
        return Response(
            {'detail': 'Failed to start session'},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def end_step_session(request):
    """
    End and finalize a step-syncing session.
    
    Request:
    {
      "session_id": "uuid",
      "session_token": "opaque-token"
    }
    
    Response:
    {
      "session_id": "uuid",
      "status": "completed",
      "session_risk_score": 15.3,
      "accepted_steps": 4200,
      "rejected_steps": 50,
      "reward_multiplier": 0.95,
      "trust_adjustment": 0.5,
      "message": "Activity synced successfully."
    }
    """
    serializer = StepSessionEndSerializer(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    
    session_id = serializer.validated_data['session_id']
    session_token = serializer.validated_data['session_token']
    
    try:
        # Retrieve and verify session
        session = StepSession.objects.get(id=session_id, user=request.user)
        
        if not verify_session_token(session_token, session.session_token_hash):
            return Response(
                {'detail': 'Invalid session token'},
                status=status.HTTP_401_UNAUTHORIZED
            )
        
        if session.status != 'active':
            return Response(
                {'detail': f'Session is already {session.status}'},
                status=status.HTTP_400_BAD_REQUEST
            )
        
        # Finalize session
        finalization = finalize_step_session(session)
        
        return Response(finalization, status=status.HTTP_200_OK)
    
    except StepSession.DoesNotExist:
        return Response(
            {'detail': 'Session not found'},
            status=status.HTTP_404_NOT_FOUND
        )
    except Exception as e:
        logger.exception(f"Error ending session {session_id}: {e}")
        return Response(
            {'detail': 'Failed to end session'},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def get_user_trust_profile(request):
    """
    Get user's trust profile.
    
    Response:
    {
      "trust_score": 67.5,
      "trust_tier": "standard",
      "verified_sessions_count": 12,
      "suspicious_sessions_count": 1,
      "total_accepted_steps": 65000,
      "total_rejected_steps": 2500
    }
    """
    profile = get_or_create_user_trust_profile(request.user)
    serializer = UserTrustProfileSerializer(profile)
    return Response(serializer.data, status=status.HTTP_200_OK)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def get_active_policy(request):
    """
    Get active anti-cheat policy (public, non-sensitive values only).
    
    Response:
    {
      "version": "anti-cheat-policy-v1",
      "session_max_hours": 12,
      "sync_interval_seconds": 30
    }
    """
    try:
        policy = AntiCheatPolicy.objects.filter(is_active=True).first()
        
        if not policy:
            # Return safe defaults
            data = {
                'version': 'default-v1',
                'session_max_hours': 12,
                'sync_interval_seconds': 30,
            }
        else:
            config = policy.config
            data = {
                'version': policy.version,
                'session_max_hours': config.get('session', {}).get('max_session_hours', 12),
                'sync_interval_seconds': int(config.get('session', {}).get('sync_interval_seconds', 30)),
            }
        
        return Response(data, status=status.HTTP_200_OK)
    
    except Exception as e:
        logger.exception(f"Error retrieving policy: {e}")
        return Response(
            {'detail': 'Failed to retrieve policy'},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR
        )
