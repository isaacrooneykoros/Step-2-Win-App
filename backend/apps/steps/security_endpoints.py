"""
Step2Win Security Endpoints - Session management, trust profiles, and anti-cheat policy.
Part of the production security hardening implementation.
"""

import logging
from datetime import timedelta

from django.db import transaction
from django.utils import timezone
from rest_framework import serializers, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from . import integrity
from .anti_cheat import finalize_step_session
from .evidence import clean_tz_offset
from .models import (AntiCheatPolicy, DeviceRegistration, StepSession,
                     StepSyncEvent, SuspiciousSessionReview, UserTrustProfile)
from .security import (create_session_token, get_active_policy_version,
                       get_or_create_user_trust_profile,
                       get_trust_reward_modifier, hash_session_token,
                       verify_session_token)
from .serializers import (AntiCheatPolicyPublicSerializer,
                          StepSessionEndResponseSerializer,
                          StepSessionEndSerializer,
                          StepSessionIntegritySerializer,
                          StepSessionStartResponseSerializer,
                          StepSessionStartSerializer,
                          UserTrustProfileSerializer)

logger = logging.getLogger(__name__)


@api_view(["POST"])
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

    device_id = serializer.validated_data["device_id"]
    platform = serializer.validated_data["platform"]
    app_version = serializer.validated_data.get("app_version")
    ml_model_version = serializer.validated_data.get("ml_model_version")
    tz_offset = clean_tz_offset(serializer.validated_data.get("tz_offset_minutes"))
    tz_name = (serializer.validated_data.get("tz_name") or "")[:64]
    install_id = (serializer.validated_data.get("install_id") or "")[:64]
    signals = integrity.clean_device_signals(serializer.validated_data.get("device_signals"))

    try:
        with transaction.atomic():
            # Register or update device
            device, created = DeviceRegistration.objects.get_or_create(
                user=request.user,
                device_id=device_id,
                defaults={
                    "platform": platform,
                    "app_version": app_version,
                    "trust_level": "new",
                },
            )

            # Update device info if provided
            device.platform = platform
            if app_version:
                device.app_version = app_version
            device.last_seen_at = timezone.now()
            device.save(
                update_fields=["platform", "app_version", "last_seen_at", "updated_at"]
            )

            # Create new session
            session_token = create_session_token()
            session_token_hash = hash_session_token(session_token)
            server_nonce = integrity.new_nonce()

            session = StepSession.objects.create(
                user=request.user,
                device=device,
                session_token_hash=session_token_hash,
                server_nonce=server_nonce,
                expires_at=timezone.now() + timedelta(hours=12),
                policy_version=get_active_policy_version(),
                ml_model_version=ml_model_version,
                tz_offset_minutes=tz_offset,
                tz_name=tz_name,
                install_id=install_id,
                # Phase 1b: Play Integrity verdict (the nonce is server_nonce). Shadow
                # heuristics from the app are stored, never enforced.
                integrity_status=(
                    "unchecked" if integrity.verifier_configured() else "unavailable"
                ),
                integrity_verdict=(
                    {"heuristics": signals, "heuristic_flags": integrity.heuristic_flags(signals)}
                    if signals
                    else {}
                ),
            )

            # Get policy version
            policy_version = session.policy_version

        # Return session details (token only returned once)
        response_data = {
            "session_id": str(session.id),
            "session_token": session_token,  # Only returned now
            "server_nonce": server_nonce,
            "expires_at": session.expires_at.isoformat(),
            "sequence_start": 1,
            "policy_version": policy_version,
            # Play Integrity: the nonce to bind the token to, and whether to send one.
            "integrity_nonce": server_nonce,
            "integrity_requested": platform == "android"
            and integrity.verifier_configured(),
        }

        return Response(response_data, status=status.HTTP_201_CREATED)

    except Exception as e:
        logger.exception(f"Error starting session for user {request.user.id}: {e}")
        return Response(
            {"detail": "Failed to start session"},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )


@api_view(["POST"])
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

    session_id = serializer.validated_data["session_id"]
    session_token = serializer.validated_data["session_token"]

    try:
        # Retrieve and verify session
        session = StepSession.objects.get(id=session_id, user=request.user)

        if not verify_session_token(session_token, session.session_token_hash):
            return Response(
                {"detail": "Invalid session token"}, status=status.HTTP_401_UNAUTHORIZED
            )

        if session.status != "active":
            return Response(
                {"detail": f"Session is already {session.status}"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Finalize session
        finalization = finalize_step_session(session)

        return Response(finalization, status=status.HTTP_200_OK)

    except StepSession.DoesNotExist:
        return Response(
            {"detail": "Session not found"}, status=status.HTTP_404_NOT_FOUND
        )
    except Exception as e:
        logger.exception(f"Error ending session {session_id}: {e}")
        return Response(
            {"detail": "Failed to end session"},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )


@api_view(["GET"])
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


@api_view(["GET"])
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
                "version": "default-v1",
                "session_max_hours": 12,
                "sync_interval_seconds": 30,
            }
        else:
            config = policy.config
            data = {
                "version": policy.version,
                "session_max_hours": config.get("session", {}).get(
                    "max_session_hours", 12
                ),
                "sync_interval_seconds": int(
                    config.get("session", {}).get("sync_interval_seconds", 30)
                ),
            }

        return Response(data, status=status.HTTP_200_OK)

    except Exception as e:
        logger.exception(f"Error retrieving policy: {e}")
        return Response(
            {"detail": "Failed to retrieve policy"},
            status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def step_session_integrity(request):
    """
    Play Integrity token for a step session (Phase 1b).

    Request: {"session_id", "session_token", "integrity_token"}; the token must be
    bound to the session's integrity_nonce (returned by session/start/).
    Response: {"integrity_status": verified | failed | unavailable | error}.
    Shadow by default: the verdict is recorded; only the admin "enforce" policy makes
    a failed session's steps count for goals only. Never a fraud flag.
    """
    serializer = StepSessionIntegritySerializer(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    data = serializer.validated_data
    session = StepSession.objects.filter(id=data["session_id"], user=request.user).first()
    if session is None:
        return Response({"detail": "Session not found"}, status=status.HTTP_404_NOT_FOUND)
    if not verify_session_token(data["session_token"], session.session_token_hash):
        return Response({"detail": "Invalid session token"}, status=status.HTTP_401_UNAUTHORIZED)
    result = integrity.record_integrity(session, data["integrity_token"], nonce_field="server_nonce")
    return Response({"integrity_status": result}, status=status.HTTP_200_OK)
