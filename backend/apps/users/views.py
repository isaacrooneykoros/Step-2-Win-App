import hashlib
import hmac
import logging

from django.conf import settings
from django.contrib.auth import authenticate
from django.db import transaction
from django.utils import timezone
from django.utils.text import slugify
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import generics, serializers, status
from rest_framework.decorators import (api_view, permission_classes,
                                       throttle_classes)
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle
from rest_framework_simplejwt.tokens import RefreshToken

from apps.admin_api.models import SupportTicket, SupportTicketMessage
from apps.core.throttles import (DashboardReadRateThrottle,
                                 DeviceBindRateThrottle, LoginRateThrottle,
                                 ProfilePictureUploadRateThrottle,
                                 RegisterRateThrottle, SocialAuthRateThrottle)
from apps.core.url_utils import build_absolute_media_url

from .models import User
from .serializers import (AppleAuthSerializer, ChangePasswordSerializer,
                          GoogleAuthSerializer,
                          LoginSerializer, RegisterSerializer,
                          SupportTicketCreateSerializer, UserProfileSerializer,
                          UserSupportTicketMessageSerializer,
                          UserSupportTicketSerializer)

logger = logging.getLogger(__name__)


class WalletThrottle(UserRateThrottle):
    """Custom throttle for wallet operations"""

    scope = "wallet"


@extend_schema(
    request=RegisterSerializer,
    responses={
        201: inline_serializer(
            name="RegisterResponse",
            fields={
                "access": serializers.CharField(),
                "refresh": serializers.CharField(),
                "user": UserProfileSerializer(),
            },
        )
    },
)
@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([RegisterRateThrottle])
def register(request):
    """
    Register a new user
    """
    from apps.admin_api.platform import feature_block

    blocked = feature_block("registrations")
    if blocked:
        return blocked

    serializer = RegisterSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    user = serializer.save()

    # Generate JWT tokens
    refresh = RefreshToken.for_user(user)

    return Response(
        {
            "access": str(refresh.access_token),
            "refresh": str(refresh),
            "user": UserProfileSerializer(user).data,
        },
        status=status.HTTP_201_CREATED,
    )


@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([LoginRateThrottle])
def login(request):
    """
    Authenticate user and return tokens
    Supports login with username, email, or phone number
    """
    serializer = LoginSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    username_or_email_or_phone = serializer.validated_data["username"]
    password = serializer.validated_data["password"]

    # Try to authenticate with username first
    user = authenticate(
        request=request, username=username_or_email_or_phone, password=password
    )

    # If authentication failed, try to find user by email or phone number
    if not user:
        try:
            # Try to find by email
            if "@" in username_or_email_or_phone:
                user_obj = User.objects.get(email=username_or_email_or_phone)
            # Try to find by phone number
            elif username_or_email_or_phone.replace("+", "").isdigit():
                user_obj = User.objects.get(phone_number=username_or_email_or_phone)
            else:
                user_obj = None

            # If found, authenticate with the username
            if user_obj:
                user = authenticate(
                    request=request, username=user_obj.username, password=password
                )
        except User.DoesNotExist:
            pass

    if not user:
        return Response(
            {"error": "Invalid credentials"}, status=status.HTTP_401_UNAUTHORIZED
        )

    if not user.is_active:
        return Response(
            {"error": "Account is disabled"}, status=status.HTTP_403_FORBIDDEN
        )

    refresh = RefreshToken.for_user(user)

    return Response(
        {
            "access": str(refresh.access_token),
            "refresh": str(refresh),
            "user": UserProfileSerializer(user).data,
        }
    )


def _build_unique_username(email: str, full_name: str = "") -> str:
    base = ""
    if full_name:
        base = slugify(full_name).replace("-", "")
    if not base and email:
        base = email.split("@")[0]
    if not base:
        base = "user"

    base = base[:20]
    username = base
    counter = 1
    while User.objects.filter(username=username).exists():
        suffix = str(counter)
        username = f"{base[:max(1, 30 - len(suffix))]}{suffix}"
        counter += 1
    return username


_SOCIAL_AUTH_RESPONSES = {
    200: inline_serializer(
        name="SocialAuthResponse",
        fields={
            "access": serializers.CharField(),
            "refresh": serializers.CharField(),
            "session_id": serializers.CharField(),
            "created": serializers.BooleanField(),
            "user": UserProfileSerializer(),
        },
    ),
    400: inline_serializer(
        name="SocialAuthError",
        fields={"error": serializers.CharField(), "code": serializers.CharField()},
    ),
    403: inline_serializer(
        name="SocialAuthForbidden",
        fields={"error": serializers.CharField(), "code": serializers.CharField()},
    ),
    503: inline_serializer(
        name="SocialAuthUnavailable",
        fields={"error": serializers.CharField(), "code": serializers.CharField()},
    ),
}


def _social_sign_in(request, verify):
    """Shared tail of Google/Apple sign-in: verify → resolve user → JWT + DeviceSession."""
    from django.contrib.auth.models import update_last_login

    from .auth_views import get_client_ip
    from .models import DeviceSession
    from .social_auth import SocialAuthError, resolve_user

    try:
        identity = verify()
        resolved = resolve_user(identity)
    except SocialAuthError as exc:
        body = {"error": exc.message, "code": exc.code, **getattr(exc, "extra", {})}
        return Response(body, status=exc.status_code)

    user = resolved.user
    if not user.is_active:
        return Response(
            {"error": "Account is disabled", "code": "account_disabled"},
            status=status.HTTP_403_FORBIDDEN,
        )

    refresh = RefreshToken.for_user(user)
    update_last_login(None, user)
    data = {
        "access": str(refresh.access_token),
        "refresh": str(refresh),
        "created": resolved.created,
        "user": UserProfileSerializer(user).data,
    }
    try:
        session = DeviceSession.objects.create(
            user=user,
            refresh_jti=refresh.get("jti"),
            device_type=request.data.get("device_type") or "unknown",
            device_name=(request.data.get("device_name") or "")[:255],
            app_version=(request.data.get("app_version") or "")[:50],
            ip_address=get_client_ip(request),
        )
        data["session_id"] = str(session.id)
    except Exception as exc:  # session tracking must not block sign-in
        logger.error("DeviceSession creation failed (%s sign-in): %s", identity.provider, exc)

    logger.info(
        "Social sign-in: provider=%s user=%s created=%s linked=%s",
        identity.provider, user.pk, resolved.created, resolved.linked,
    )
    return Response(data, status=status.HTTP_201_CREATED if resolved.created else status.HTTP_200_OK)


@extend_schema(request=GoogleAuthSerializer, responses=_SOCIAL_AUTH_RESPONSES)
@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([SocialAuthRateThrottle])
def google_auth(request):
    """
    Sign in (or sign up) with a Google ID token.

    The token is verified locally (signature, issuer, audience ∈ GOOGLE_OAUTH_CLIENT_IDS,
    expiry, nonce when sent, verified email). Access tokens are not accepted.
    """
    from .social_auth import verify_google_id_token

    serializer = GoogleAuthSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    vd = serializer.validated_data
    return _social_sign_in(
        request, lambda: verify_google_id_token(vd["id_token"], vd.get("nonce") or None)
    )


@extend_schema(request=AppleAuthSerializer, responses=_SOCIAL_AUTH_RESPONSES)
@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([SocialAuthRateThrottle])
def apple_auth(request):
    """
    Sign in (or sign up) with an Apple identity token.

    Verified against Apple's JWKS: issuer, audience ∈ APPLE_CLIENT_IDS (bundle id /
    Services ID), expiry, and nonce == SHA-256(raw nonce sent by the app).
    """
    from .social_auth import verify_apple_identity_token

    serializer = AppleAuthSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    vd = serializer.validated_data
    return _social_sign_in(
        request,
        lambda: verify_apple_identity_token(
            vd["id_token"], vd["nonce"], vd.get("given_name", ""), vd.get("family_name", "")
        ),
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def logout(request):
    """
    Blacklist the refresh token
    """
    try:
        refresh_token = request.data.get("refresh")
        if refresh_token:
            token = RefreshToken(refresh_token)
            token.blacklist()
        return Response({"status": "Successfully logged out"})
    except Exception:
        return Response({"error": "Invalid token"}, status=status.HTTP_400_BAD_REQUEST)


class ProfileView(generics.RetrieveUpdateAPIView):
    """
    Get or update user profile
    Supports both PUT (partial update) and PATCH (partial update)
    Automatically handles daily reset and streak calculation on retrieval
    """

    serializer_class = UserProfileSerializer
    permission_classes = [IsAuthenticated]
    throttle_classes = [DashboardReadRateThrottle]
    queryset = User.objects.all()

    def get_object(self):
        return self.request.user

    def retrieve(self, request, *args, **kwargs):
        """Override retrieve to handle daily reset"""
        from apps.steps.daily_reset import reset_daily_stats_if_needed

        user = self.get_object()
        reset_daily_stats_if_needed(user)

        return super().retrieve(request, *args, **kwargs)

    def put(self, request, *args, **kwargs):
        """Handle PUT requests as partial updates"""
        return self.partial_update(request, *args, **kwargs)


@extend_schema(
    request=inline_serializer(
        name="UploadProfilePictureRequest",
        fields={
            "profile_picture": serializers.ImageField(),
        },
    ),
    responses={
        200: inline_serializer(
            name="UploadProfilePictureResponse",
            fields={
                "status": serializers.CharField(),
                "profile_picture_url": serializers.CharField(),
                "message": serializers.CharField(),
            },
        )
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
@throttle_classes([ProfilePictureUploadRateThrottle])
def upload_profile_picture(request):
    """
    Upload a profile picture for the current user
    """
    from .serializers import ProfilePictureSerializer

    serializer = ProfilePictureSerializer(data=request.FILES)
    serializer.is_valid(raise_exception=True)

    user = request.user
    cooldown_minutes = int(getattr(settings, "PROFILE_PICTURE_COOLDOWN_MINUTES", 10))
    if user.last_profile_picture_update:
        seconds_since_last = (
            timezone.now() - user.last_profile_picture_update
        ).total_seconds()
        if seconds_since_last < cooldown_minutes * 60:
            wait_seconds = int(cooldown_minutes * 60 - seconds_since_last)
            return Response(
                {
                    "error": (
                        f"Profile picture can only be changed every {cooldown_minutes} minutes. "
                        f"Try again in {wait_seconds} seconds."
                    )
                },
                status=status.HTTP_429_TOO_MANY_REQUESTS,
            )

    # Delete old profile picture if it exists
    if user.profile_picture:
        user.profile_picture.delete()

    # Save new profile picture
    user.profile_picture = serializer.validated_data["profile_picture"]
    user.last_profile_picture_update = timezone.now()
    user.save()

    return Response(
        {
            "status": "success",
            "profile_picture_url": build_absolute_media_url(
                user.profile_picture.url if user.profile_picture else None,
                request=request,
            ),
            "message": "Profile picture uploaded successfully",
        },
        status=status.HTTP_200_OK,
    )


@api_view(["DELETE"])
@permission_classes([IsAuthenticated])
@extend_schema(
    request=None,
    responses={
        200: inline_serializer(
            name="DeleteProfilePictureResponse",
            fields={
                "status": serializers.CharField(),
                "message": serializers.CharField(),
            },
        ),
        400: inline_serializer(
            name="DeleteProfilePictureError",
            fields={
                "status": serializers.CharField(),
                "message": serializers.CharField(),
            },
        ),
    },
)
def delete_profile_picture(request):
    """
    Delete the current user's profile picture
    """
    user = request.user

    if user.profile_picture:
        user.profile_picture.delete()
        user.profile_picture = None
        user.last_profile_picture_update = None
        user.save()

        return Response(
            {"status": "success", "message": "Profile picture deleted successfully"},
            status=status.HTTP_200_OK,
        )

    return Response(
        {"status": "error", "message": "No profile picture to delete"},
        status=status.HTTP_400_BAD_REQUEST,
    )


@extend_schema(
    request=inline_serializer(
        name="BindDeviceRequest",
        fields={
            "device_id": serializers.CharField(),
            "platform": serializers.ChoiceField(choices=["android", "ios"]),
        },
    ),
    responses={
        200: inline_serializer(
            name="BindDeviceResponse",
            fields={
                "status": serializers.CharField(),
                "device_id": serializers.CharField(),
                "platform": serializers.CharField(),
            },
        )
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
@throttle_classes([DeviceBindRateThrottle])
def bind_device(request):
    """
    Bind a device to user account for step tracking
    """
    device_id = str(request.data.get("device_id", "")).strip()
    platform = request.data.get("platform")
    device_signature = (request.data.get("device_signature") or "").strip()

    if not device_id:
        return Response(
            {"error": "device_id required"}, status=status.HTTP_400_BAD_REQUEST
        )

    if platform not in ["android", "ios"]:
        return Response(
            {"error": "platform must be android or ios"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    # Enforce high-entropy, non-guessable device IDs.
    if len(device_id) < 32:
        return Response(
            {"error": "device_id must be at least 32 characters"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    signing_secret = (getattr(settings, "APP_SIGNING_SECRET", "") or "").strip()
    if not signing_secret:
        return Response(
            {"error": "Device binding is unavailable due to server configuration"},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    if not device_signature:
        return Response(
            {"error": "device_signature required"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    signature_payload = f"{request.user.id}:{device_id}:{platform}"
    expected_signature = hmac.new(
        signing_secret.encode(),
        signature_payload.encode(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(device_signature, expected_signature):
        return Response(
            {"error": "Invalid device signature"},
            status=status.HTTP_403_FORBIDDEN,
        )

    # Check if device is already bound to another account
    if User.objects.filter(device_id=device_id).exclude(id=request.user.id).exists():
        return Response(
            {"error": "Device already bound to another account"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    with transaction.atomic():
        user = User.objects.select_for_update().get(id=request.user.id)
        user.device_id = device_id
        user.device_platform = platform
        user.save()

    return Response(
        {
            "status": "Device bound successfully",
            "device_id": device_id,
            "platform": platform,
        }
    )


@extend_schema(
    responses={
        200: inline_serializer(
            name="DeviceStatusResponse",
            fields={
                "bound": serializers.BooleanField(),
                "platform": serializers.CharField(allow_null=True),
                "device_id": serializers.CharField(allow_null=True),
                "last_sync": serializers.DateField(allow_null=True),
                "last_sync_time": serializers.DateTimeField(allow_null=True),
            },
        )
    }
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def device_status(request):
    """
    Get device binding status and last sync info
    """
    from apps.steps.models import HealthRecord

    last_sync = HealthRecord.objects.filter(user=request.user).order_by("-date").first()

    return Response(
        {
            "bound": request.user.device_id is not None,
            "platform": request.user.device_platform,
            "device_id": request.user.device_id,
            "last_sync": last_sync.date if last_sync else None,
            "last_sync_time": last_sync.synced_at if last_sync else None,
        }
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def change_password(request):
    """
    Change user password
    """
    serializer = ChangePasswordSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    # Check old password
    if not request.user.check_password(serializer.validated_data["old_password"]):
        return Response(
            {"error": "Old password is incorrect"}, status=status.HTTP_400_BAD_REQUEST
        )

    # Set new password
    request.user.set_password(serializer.validated_data["new_password"])
    request.user.save()

    return Response({"status": "Password updated successfully"})


@extend_schema(
    responses={
        200: inline_serializer(
            name="UserStatsResponse",
            fields={
                "username": serializers.CharField(),
                "total_steps": serializers.IntegerField(),
                "challenges_won": serializers.IntegerField(),
                "total_earned": serializers.CharField(),
                "current_streak": serializers.IntegerField(),
                "wallet_balance": serializers.CharField(),
                "locked_balance": serializers.CharField(),
                "available_balance": serializers.CharField(),
                "member_since": serializers.CharField(),
            },
        )
    }
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def user_stats(request):
    """
    Get detailed user statistics
    """
    user = request.user

    return Response(
        {
            "username": user.username,
            "total_steps": user.total_steps,
            "challenges_won": user.challenges_won,
            "total_earned": str(user.total_earned),
            "current_streak": user.current_streak,
            "wallet_balance": str(user.wallet_balance),
            "locked_balance": str(user.locked_balance),
            "available_balance": str(user.available_balance),
            "member_since": user.date_joined.strftime("%B %Y"),
        }
    )


@extend_schema(
    request=SupportTicketCreateSerializer,
    responses={201: UserSupportTicketSerializer},
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def create_support_ticket(request):
    """Create a support ticket and initial user message"""
    from apps.admin_api.realtime import (broadcast_support_message,
                                         broadcast_support_ticket)

    serializer = SupportTicketCreateSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)

    ticket = SupportTicket.objects.create(
        user=request.user,
        subject=serializer.validated_data["subject"].strip(),
        category=serializer.validated_data["category"],
        priority=serializer.validated_data["priority"],
        message=serializer.validated_data["message"].strip(),
        status="open",
    )

    initial_message = SupportTicketMessage.objects.create(
        ticket=ticket,
        sender=request.user,
        sender_username=request.user.username,
        is_admin=False,
        message=serializer.validated_data["message"].strip(),
    )

    # Settings > Support: optional auto-assignment (never blocks creation).
    from apps.admin_api.support_rules import auto_assign

    auto_assign(ticket)

    broadcast_support_message(
        ticket.id,
        {
            "id": initial_message.id,
            "ticket": ticket.id,
            "sender": request.user.id,
            "sender_username": request.user.username,
            "is_admin": False,
            "message": initial_message.message,
            "created_at": initial_message.created_at.isoformat(),
        },
    )
    broadcast_support_ticket(
        ticket.id,
        {
            "id": ticket.id,
            "status": ticket.status,
            "priority": ticket.priority,
            "updated_at": ticket.updated_at.isoformat(),
            "message_count": 1,
        },
    )

    return Response(
        UserSupportTicketSerializer(ticket).data, status=status.HTTP_201_CREATED
    )


@extend_schema(
    operation_id="auth_support_tickets_list",
    responses={
        200: inline_serializer(
            name="MySupportTicketsResponse",
            fields={
                "total": serializers.IntegerField(),
                "results": UserSupportTicketSerializer(many=True),
            },
        )
    },
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def my_support_tickets(request):
    """List current user's support tickets"""
    tickets = SupportTicket.objects.filter(user=request.user)

    status_filter = request.query_params.get("status")
    if status_filter:
        tickets = tickets.filter(status=status_filter)

    try:
        limit = max(1, min(100, int(request.query_params.get("limit", 20))))
        offset = max(0, int(request.query_params.get("offset", 0)))
    except ValueError:
        return Response(
            {"error": "Invalid pagination parameters"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    total = tickets.count()
    paged = tickets[offset : offset + limit]

    return Response(
        {
            "total": total,
            "results": UserSupportTicketSerializer(paged, many=True).data,
        }
    )


@extend_schema(
    operation_id="auth_support_ticket_detail",
    responses={
        200: inline_serializer(
            name="MySupportTicketDetailResponse",
            fields={
                "ticket": UserSupportTicketSerializer(),
                "messages": UserSupportTicketMessageSerializer(many=True),
            },
        ),
        404: inline_serializer(
            name="MySupportTicketNotFound",
            fields={"error": serializers.CharField()},
        ),
    },
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def my_support_ticket_detail(request, ticket_id):
    """Get one support ticket and message thread for current user"""
    try:
        ticket = SupportTicket.objects.get(id=ticket_id, user=request.user)
    except SupportTicket.DoesNotExist:
        return Response(
            {"error": "Support ticket not found"}, status=status.HTTP_404_NOT_FOUND
        )

    messages = ticket.messages.all()
    return Response(
        {
            "ticket": UserSupportTicketSerializer(ticket).data,
            "messages": UserSupportTicketMessageSerializer(messages, many=True).data,
        }
    )


@extend_schema(
    request=inline_serializer(
        name="ReplySupportTicketRequest",
        fields={"message": serializers.CharField()},
    ),
    responses={
        200: inline_serializer(
            name="ReplySupportTicketResponse",
            fields={"status": serializers.CharField()},
        ),
        400: inline_serializer(
            name="ReplySupportTicketBadRequest",
            fields={"error": serializers.CharField()},
        ),
        404: inline_serializer(
            name="ReplySupportTicketNotFound",
            fields={"error": serializers.CharField()},
        ),
    },
)
@api_view(["POST"])
@permission_classes([IsAuthenticated])
def reply_support_ticket(request, ticket_id):
    """Add a user reply to an existing support ticket"""
    from apps.admin_api.realtime import (broadcast_support_message,
                                         broadcast_support_ticket)

    try:
        ticket = SupportTicket.objects.get(id=ticket_id, user=request.user)
    except SupportTicket.DoesNotExist:
        return Response(
            {"error": "Support ticket not found"}, status=status.HTTP_404_NOT_FOUND
        )

    message = str(request.data.get("message", "")).strip()
    if not message:
        return Response(
            {"error": "message is required"}, status=status.HTTP_400_BAD_REQUEST
        )

    reply = SupportTicketMessage.objects.create(
        ticket=ticket,
        sender=request.user,
        sender_username=request.user.username,
        is_admin=False,
        message=message,
    )

    if ticket.status in ["resolved", "closed"]:
        ticket.status = "in_progress"
    if not ticket.message:
        ticket.message = message
    ticket.save(update_fields=["status", "message", "updated_at"])

    broadcast_support_message(
        ticket.id,
        {
            "id": reply.id,
            "ticket": ticket.id,
            "sender": request.user.id,
            "sender_username": request.user.username,
            "is_admin": False,
            "message": reply.message,
            "created_at": reply.created_at.isoformat(),
        },
    )
    broadcast_support_ticket(
        ticket.id,
        {
            "id": ticket.id,
            "status": ticket.status,
            "priority": ticket.priority,
            "updated_at": ticket.updated_at.isoformat(),
        },
    )

    return Response({"status": "Reply sent successfully"})


@extend_schema(
    request=inline_serializer(
        name="UpdateTicketStatusRequest",
        fields={"status": serializers.CharField()},
    ),
    responses={
        200: inline_serializer(
            name="UpdateTicketStatusResponse",
            fields={
                "status": serializers.CharField(),
                "ticket": UserSupportTicketSerializer(),
            },
        ),
        400: inline_serializer(
            name="UpdateTicketStatusBadRequest",
            fields={"error": serializers.CharField()},
        ),
        404: inline_serializer(
            name="UpdateTicketStatusNotFound",
            fields={"error": serializers.CharField()},
        ),
    },
)
@api_view(["PATCH"])
@permission_classes([IsAuthenticated])
def update_ticket_status(request, ticket_id):
    """Allow user to mark their ticket as resolved or reopen it"""
    from apps.admin_api.realtime import broadcast_support_ticket

    try:
        ticket = SupportTicket.objects.get(id=ticket_id, user=request.user)
    except SupportTicket.DoesNotExist:
        return Response(
            {"error": "Support ticket not found"}, status=status.HTTP_404_NOT_FOUND
        )

    new_status = str(request.data.get("status", "")).strip()

    # Users can only mark as resolved or reopen (set to in_progress)
    allowed_statuses = ["resolved", "in_progress", "open"]
    if new_status not in allowed_statuses:
        return Response(
            {"error": f'Invalid status. Allowed: {", ".join(allowed_statuses)}'},
            status=status.HTTP_400_BAD_REQUEST,
        )

    old_status = ticket.status
    ticket.status = new_status

    # Set resolved_at timestamp if marking as resolved
    if new_status == "resolved" and old_status != "resolved":
        from django.utils import timezone

        ticket.resolved_at = timezone.now()
    elif new_status != "resolved":
        ticket.resolved_at = None

    ticket.save(update_fields=["status", "resolved_at", "updated_at"])

    broadcast_support_ticket(
        ticket.id,
        {
            "id": ticket.id,
            "status": ticket.status,
            "priority": ticket.priority,
            "updated_at": ticket.updated_at.isoformat(),
            "resolved_at": (
                ticket.resolved_at.isoformat() if ticket.resolved_at else None
            ),
        },
    )

    return Response(
        {
            "status": "Ticket status updated",
            "ticket": UserSupportTicketSerializer(ticket).data,
        }
    )


@extend_schema(
    request=inline_serializer(
        name="UpdateDailyGoalRequest",
        fields={
            "daily_goal": serializers.IntegerField(min_value=1000, max_value=60000),
        },
    ),
    responses={
        200: inline_serializer(
            name="UpdateDailyGoalResponse",
            fields={
                "daily_goal": serializers.IntegerField(),
                "message": serializers.CharField(),
            },
        )
    },
)
@api_view(["PATCH"])
@permission_classes([IsAuthenticated])
def update_daily_goal(request):
    """
    Updates the user's personal daily step goal.
    Called when user sets a new goal from the home screen modal.

    Request body:
        { "daily_goal": 12000 }

    Constraints:
        - Must be between 1,000 and 60,000 steps
        - 60,000 is the platform's daily step cap (anti-cheat limit)
    """
    goal = request.data.get("daily_goal")

    if goal is None:
        return Response(
            {"error": "daily_goal is required"}, status=status.HTTP_400_BAD_REQUEST
        )

    try:
        goal = int(goal)
    except (TypeError, ValueError):
        return Response(
            {"error": "daily_goal must be an integer"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if goal < 1000:
        return Response(
            {"error": "Daily goal must be at least 1,000 steps"},
            status=status.HTTP_400_BAD_REQUEST,
        )
    if goal > 60000:
        return Response(
            {"error": "Daily goal cannot exceed 60,000 steps (platform cap)"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    request.user.daily_goal = goal
    request.user.save(update_fields=["daily_goal"])

    return Response(
        {
            "daily_goal": goal,
            "message": f"Daily goal set to {goal:,} steps.",
        }
    )
