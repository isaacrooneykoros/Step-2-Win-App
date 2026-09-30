import logging
import os
from datetime import timedelta
from decimal import Decimal

from django.conf import settings
from django.contrib.auth import authenticate
from django.contrib.auth.password_validation import validate_password
from django.core.cache import cache
from django.db import transaction as db_transaction
from django.db.models import Count, Max, Min, Q, Sum
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import permissions, serializers, status, viewsets
from rest_framework.decorators import (action, api_view, parser_classes,
                                       permission_classes, throttle_classes)
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken

logger = logging.getLogger(__name__)

from django.contrib.auth import get_user_model
from drf_spectacular.utils import (OpenApiTypes, extend_schema,
                                   inline_serializer)

from apps.admin_api.roles import StaffActionPermission, staff
from apps.admin_api.console import (AdminPageNumberPagination, filter_users,
                                    step_daily_totals, step_distribution,
                                    step_flag_reasons, user_overview)
from apps.admin_api.serializers import (AdminBadgeSerializer,
                                        AdminChallengeSerializer,
                                        AdminNotificationSerializer,
                                        AdminProfileSerializer,
                                        AdminTransactionSerializer,
                                        AdminUserSerializer,
                                        AdminWithdrawalSerializer,
                                        SupportTicketMessageSerializer,
                                        SupportTicketSerializer)
from apps.challenges.models import Challenge, Participant
from apps.core.locks import acquire_lock, release_lock
from apps.core.throttles import AdminLoginRateThrottle
from apps.core.url_utils import build_absolute_media_url
from apps.gamification.models import Badge, UserBadge, XPEvent
from apps.payments import intasend
from apps.payments.models import WithdrawalRequest
from apps.payments.reconciliation import run_financial_reconciliation
from apps.payments.services import (PaymentsServiceError,
                                    approve_withdrawal_and_send,
                                    reject_withdrawal_request)
from apps.payments.views import _notify_user
from apps.steps.drift_monitor import (AntiCheatDriftThresholds,
                                      run_anticheat_shadow_drift_monitor)
from apps.steps.models import HealthRecord, HourlyStepRecord
from apps.users.models import UserXP
from apps.wallet.models import WalletTransaction, Withdrawal

User = get_user_model()


def _admin_profile(user, request=None):
    profile_picture_url = None
    if getattr(user, "profile_picture", None):
        profile_picture_url = build_absolute_media_url(
            user.profile_picture.url, request=request
        )

    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "is_staff": user.is_staff,
        "is_superuser": user.is_superuser,
        "is_active": user.is_active,
        "profile_picture_url": profile_picture_url,
    }


class IsAdminUser(permissions.BasePermission):
    """Legacy check: any active staff account. Admin endpoints use the role-based
    permissions in apps/admin_api/roles.py (HasStaffPermission / StaffActionPermission)."""

    def has_permission(self, request, _view):
        user = request.user
        return bool(user and user.is_authenticated and user.is_active and user.is_staff)


@extend_schema(
    request=AdminProfileSerializer,
    responses={
        200: AdminProfileSerializer,
        400: OpenApiTypes.OBJECT,
        403: OpenApiTypes.OBJECT,
    },
)
@api_view(["GET", "PATCH"])
@permission_classes(staff())
@parser_classes([MultiPartParser, FormParser, JSONParser])
def current_admin_profile(request):
    """Get or update the authenticated admin profile, including profile picture."""
    serializer_cls = AdminProfileSerializer

    if request.method == "GET":
        serializer = serializer_cls(request.user, context={"request": request})
        return Response(serializer.data)

    serializer = serializer_cls(
        request.user,
        data=request.data,
        partial=True,
        context={"request": request},
    )
    serializer.is_valid(raise_exception=True)
    admin = serializer.save()

    from apps.admin_api.models import AuditLog

    AuditLog.log_action(
        admin=request.user,
        action="update",
        resource_type="user",
        resource_id=admin.id,
        resource_name=admin.username,
        description="Admin updated their own profile",
        changes={
            key: ("[file]" if hasattr(value, "name") else value)
            for key, value in serializer.validated_data.items()
        },
        request=request,
    )

    return Response(serializer_cls(admin, context={"request": request}).data)


@extend_schema(responses={200: OpenApiTypes.OBJECT, 403: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff())
def admin_notifications(request):
    """Return the admin notification summary and recent actionable alerts."""
    from apps.admin_api.models import AuditLog, SupportTicket

    now = timezone.now()
    recent_cutoff = now - timedelta(days=7)

    open_support_count = SupportTicket.objects.filter(
        status__in=["open", "in_progress"]
    ).count()
    pending_withdrawal_count = WithdrawalRequest.objects.filter(
        status="pending_review"
    ).count()
    open_support_tickets = SupportTicket.objects.filter(
        status__in=["open", "in_progress"]
    ).order_by("-updated_at")[:5]
    pending_withdrawals = WithdrawalRequest.objects.filter(
        status="pending_review"
    ).order_by("-created_at")[:5]
    recent_audit_logs = AuditLog.objects.filter(created_at__gte=recent_cutoff).order_by(
        "-created_at"
    )[:5]

    items: list[dict[str, object]] = []

    for ticket in open_support_tickets:
        items.append(
            {
                "type": "support_ticket",
                "title": f"Support ticket #{ticket.id} is {ticket.status}",
                "message": ticket.subject,
                "created_at": ticket.updated_at,
                "action_url": f"/support?ticket={ticket.id}",
                "severity": (
                    "high" if ticket.priority in {"high", "urgent"} else "medium"
                ),
            }
        )

    for withdrawal in pending_withdrawals:
        items.append(
            {
                "type": "withdrawal",
                "title": f"Withdrawal #{withdrawal.id} needs review",
                "message": f"KES {withdrawal.amount_kes} pending {withdrawal.method} approval",
                "created_at": withdrawal.created_at,
                "action_url": "/withdrawals",
                "severity": "high",
            }
        )

    for log in recent_audit_logs:
        if log.action in {
            "settings_change",
            "ban",
            "unban",
            "approve",
            "reject",
            "promote",
            "demote",
        }:
            items.append(
                {
                    "type": "audit_log",
                    "title": f'{log.resource_type.title()} {log.action.replace("_", " ")}',
                    "message": log.description,
                    "created_at": log.created_at,
                    "action_url": "/activity",
                    "severity": "low",
                }
            )

    items.sort(key=lambda item: item["created_at"], reverse=True)

    summary = {
        "total": len(items),
        "open_support_tickets": open_support_count,
        "pending_withdrawals": pending_withdrawal_count,
        "recent_audit_items": sum(
            1
            for log in recent_audit_logs
            if log.action
            in {
                "settings_change",
                "ban",
                "unban",
                "approve",
                "reject",
                "promote",
                "demote",
            }
        ),
    }

    return Response(
        {
            "summary": summary,
            "items": AdminNotificationSerializer(items, many=True).data,
        }
    )


@extend_schema(
    request=inline_serializer(
        name="AdminLoginRequest",
        fields={
            "username": serializers.CharField(),
            "password": serializers.CharField(),
        },
    ),
    responses={
        200: OpenApiTypes.OBJECT,
        400: OpenApiTypes.OBJECT,
        401: OpenApiTypes.OBJECT,
        403: OpenApiTypes.OBJECT,
    },
)
@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([AdminLoginRateThrottle])
def admin_login(request):
    """Authenticate admin user and return JWT tokens"""
    from apps.admin_api.models import AuditLog

    username = request.data.get("username", "").strip()
    password = request.data.get("password", "")

    if not username or not password:
        return Response(
            {"error": "Username and password are required"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    user = authenticate(request=request, username=username, password=password)
    if not user:
        return Response(
            {"error": "Invalid credentials"},
            status=status.HTTP_401_UNAUTHORIZED,
        )

    if not user.is_active:
        return Response(
            {"error": "Account is disabled"},
            status=status.HTTP_403_FORBIDDEN,
        )

    if not user.is_staff:
        return Response(
            {"error": "Admin access required"},
            status=status.HTTP_403_FORBIDDEN,
        )

    # Log successful login
    AuditLog.log_action(
        admin=user,
        action="login",
        resource_type="auth",
        description=f"Admin {username} logged in",
        request=request,
    )

    refresh = RefreshToken.for_user(user)
    return Response(
        {
            "access": str(refresh.access_token),
            "refresh": str(refresh),
            "user": _admin_profile(user, request=request),
        }
    )


@extend_schema(
    request=inline_serializer(
        name="AdminRegisterRequest",
        fields={
            "username": serializers.CharField(),
            "email": serializers.EmailField(),
            "password": serializers.CharField(),
            "confirm_password": serializers.CharField(),
            "admin_code": serializers.CharField(),
        },
    ),
    responses={
        201: OpenApiTypes.OBJECT,
        400: OpenApiTypes.OBJECT,
        403: OpenApiTypes.OBJECT,
    },
)
@api_view(["POST"])
@permission_classes([AllowAny])
def admin_register(request):
    """Register a staff account.

    With ``invite_code``: a person invited by the owner (Staff & roles) creates their
    account; the email must match the invite and the account gets the invite's roles.
    Without it: first-admin bootstrap only (ADMIN_REGISTRATION_CODE, while no staff
    account exists); that account is the owner (superuser)."""
    username = request.data.get("username", "").strip()
    email = request.data.get("email", "").strip()
    password = request.data.get("password", "")
    confirm_password = request.data.get("confirm_password", "")
    admin_code = request.data.get("admin_code", "").strip()
    invite_code = str(request.data.get("invite_code") or "").strip()

    if invite_code:
        return _register_with_invite(request, username, email, password, confirm_password, invite_code)

    required_code = os.getenv("ADMIN_REGISTRATION_CODE")
    if not required_code:
        return Response(
            {
                "error": "Admin registration is disabled. Set ADMIN_REGISTRATION_CODE env var."
            },
            status=status.HTTP_403_FORBIDDEN,
        )

    if not username or not email or not password or not confirm_password:
        return Response(
            {"error": "Username, email, password and confirm_password are required"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if admin_code != required_code:
        return Response(
            {"error": "Invalid admin registration code"},
            status=status.HTTP_403_FORBIDDEN,
        )

    lock_key = "admin_register_lock"
    if not cache.add(lock_key, "1", timeout=30):
        return Response(
            {"error": "Another admin registration is in progress. Please retry."},
            status=status.HTTP_429_TOO_MANY_REQUESTS,
        )

    if password != confirm_password:
        return Response(
            {"error": "Passwords do not match"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if User.objects.filter(username=username).exists():
        return Response(
            {"error": "Username already taken"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if User.objects.filter(email=email).exists():
        return Response(
            {"error": "Email already registered"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    try:
        validate_password(password)
    except Exception as error:
        message = str(error)
        return Response({"error": message}, status=status.HTTP_400_BAD_REQUEST)

    try:
        with db_transaction.atomic():
            # Lock at least one row to reduce race conditions in concurrent requests.
            User.objects.select_for_update().order_by("id").first()

            # Only allow registration if no admin accounts exist (first admin only).
            if User.objects.filter(is_staff=True).exists():
                return Response(
                    {
                        "error": "Admin registration is closed. Contact an existing admin to grant you access."
                    },
                    status=status.HTTP_403_FORBIDDEN,
                )

            # The first admin owns the console: superuser, so it can manage staff.
            user = User.objects.create_user(
                username=username,
                email=email,
                password=password,
                is_staff=True,
                is_superuser=True,
            )
    finally:
        cache.delete(lock_key)

    refresh = RefreshToken.for_user(user)
    return Response(
        {
            "access": str(refresh.access_token),
            "refresh": str(refresh),
            "user": _admin_profile(user, request=request),
        },
        status=status.HTTP_201_CREATED,
    )


def _register_with_invite(request, username, email, password, confirm_password, invite_code):
    import uuid

    from apps.admin_api.models import AuditLog, StaffInvite, StaffProfile
    from apps.admin_api.roles import OWNER, clean_roles
    from apps.admin_api.staff_views import accept_invite

    if not username or not email or not password or not confirm_password:
        return Response(
            {"error": "Username, email, password and confirm_password are required"},
            status=status.HTTP_400_BAD_REQUEST,
        )
    if password != confirm_password:
        return Response({"error": "Passwords do not match"}, status=status.HTTP_400_BAD_REQUEST)
    invite = accept_invite(invite_code, email)
    if invite is None:
        return Response(
            {"error": "This invite code is not valid for that email, or it has expired. Ask the owner for a new one."},
            status=status.HTTP_403_FORBIDDEN,
        )
    if User.objects.filter(username__iexact=username).exists():
        return Response({"error": "Username already taken"}, status=status.HTTP_400_BAD_REQUEST)
    if User.objects.filter(email__iexact=email).exists():
        return Response(
            {"error": "Email already registered. Ask the owner to grant staff access to that account instead."},
            status=status.HTTP_400_BAD_REQUEST,
        )
    try:
        validate_password(password)
    except Exception as error:
        return Response({"error": str(error)}, status=status.HTTP_400_BAD_REQUEST)

    with db_transaction.atomic():
        locked = StaffInvite.objects.select_for_update().get(id=invite.id)
        if locked.status != "pending":
            return Response({"error": "This invite was already used."}, status=status.HTTP_409_CONFLICT)
        roles = clean_roles(locked.roles)
        user = User.objects.create_user(
            username=username,
            email=email,
            password=password,
            # Staff accounts have no M-Pesa number; the column is unique and required.
            phone_number=f"staff_{uuid.uuid4().hex[:12]}",
            is_staff=True,
            is_superuser=OWNER in roles,
        )
        StaffProfile.objects.create(user=user, roles=[r for r in roles if r != OWNER], updated_by=locked.created_by)
        locked.accepted_at = timezone.now()
        locked.accepted_user = user
        locked.save(update_fields=["accepted_at", "accepted_user"])
        AuditLog.log_action(
            admin=user, action="invite", resource_type="staff", resource_id=user.id, resource_name=user.username,
            description=f"{user.username} accepted a staff invite",
            changes={"invite_id": locked.id, "roles": roles}, request=request,
        )

    refresh = RefreshToken.for_user(user)
    return Response(
        {
            "access": str(refresh.access_token),
            "refresh": str(refresh),
            "user": _admin_profile(user, request=request),
        },
        status=status.HTTP_201_CREATED,
    )


class NoDefaultWritesMixin:
    """
    Blocks the ModelViewSet's generic create/update/delete routes. The console uses the
    dedicated actions below, which validate, protect money and write the audit log; the
    generic routes skipped all of that (e.g. PATCH is_staff, or DELETE a live challenge).
    """

    def _no_generic_write(self):
        return Response(
            {"error": "Use the dedicated admin action for this change.", "code": "use_admin_action"},
            status=status.HTTP_405_METHOD_NOT_ALLOWED,
        )

    def create(self, request, *args, **kwargs):
        return self._no_generic_write()

    def update(self, request, *args, **kwargs):
        return self._no_generic_write()

    def partial_update(self, request, *args, **kwargs):
        return self._no_generic_write()

    def destroy(self, request, *args, **kwargs):
        return self._no_generic_write()


class AdminUserViewSet(NoDefaultWritesMixin, viewsets.ModelViewSet):
    """
    Admin user management endpoint
    """

    queryset = User.objects.all()
    serializer_class = AdminUserSerializer
    permission_classes = [permissions.IsAuthenticated, StaffActionPermission]
    # Role permission per action (apps/admin_api/roles.py); "*" = reads.
    staff_perms = {
        "*": "console.view",
        "ban_user": "users.ban",
        "unban_user": "users.ban",
        "reset_password": "users.edit",
        "update_user": "users.edit",
        "update_me": "console.view",
        "delete_user": "owner.delete_users",
        "sign_out_everywhere": "users.edit",
        "unlock_login": "users.edit",
        "message": "users.edit",
        "reset_device": "users.devices",
        "adjust_xp": "users.xp",
        "revoke_badge": "users.xp",
        "export": "users.export",
        "correct_steps": "steps.correct",
    }
    search_fields = ["username", "email"]
    filterset_fields = ["is_active", "is_staff"]
    pagination_class = AdminPageNumberPagination

    def get_queryset(self):
        qs = super().get_queryset()
        if self.action == "list":
            return filter_users(qs, self.request.query_params)
        return qs

    def _audit(self, request, user, action_name, description, changes=None):
        from apps.admin_api.models import AuditLog

        reason = str(request.data.get("reason") or "").strip()[:500]
        payload = dict(changes or {})
        if reason:
            payload["reason"] = reason
        AuditLog.log_action(
            admin=request.user,
            action=action_name,
            resource_type="user",
            resource_id=user.id,
            resource_name=user.username,
            description=description,
            changes=payload or None,
            request=request,
        )

    @staticmethod
    def _staff_target_guard(request, user):
        """Only the owner may change another staff account (password, details, access):
        otherwise a support agent could take over an owner's account."""
        from apps.admin_api.roles import is_owner

        if user.is_staff and user.id != request.user.id and not is_owner(request.user):
            return Response(
                {"error": "Only the owner can change staff accounts.", "code": "staff_target"},
                status=status.HTTP_403_FORBIDDEN,
            )
        return None

    @staticmethod
    def _deleted_guard(user):
        """Accounts deleted by their owner are anonymised and can't be restored or edited."""
        if getattr(user, "deleted_at", None):
            return Response(
                {
                    "error": "This account was deleted by its owner. It can't be restored or edited.",
                    "code": "account_deleted",
                },
                status=status.HTTP_409_CONFLICT,
            )
        return None

    @action(detail=True, methods=["get"])
    def overview(self, request, pk=None):
        """Account, activity, money, trust, support and audit data for one user."""
        user = self.get_object()
        data = user_overview(user)
        data["user"] = AdminUserSerializer(user).data
        return Response(data)

    @action(detail=True, methods=["post"])
    def ban_user(self, request, pk=None):
        """Ban a specific user"""
        user = self.get_object()
        if denied := self._staff_target_guard(request, user):
            return denied
        if user.id == request.user.id:
            return Response(
                {"error": "You cannot ban your own account"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        user.is_active = False
        user.save()
        self._audit(request, user, "ban", f"Banned {user.username}", {"is_active": {"old": True, "new": False}})
        return Response({"status": f"User {user.username} has been banned"})

    @action(detail=True, methods=["post"])
    def unban_user(self, request, pk=None):
        """Unban a specific user"""
        user = self.get_object()
        if denied := self._staff_target_guard(request, user) or self._deleted_guard(user):
            return denied
        user.is_active = True
        user.save()
        self._audit(request, user, "unban", f"Unbanned {user.username}", {"is_active": {"old": False, "new": True}})
        return Response({"status": f"User {user.username} has been unbanned"})

    # Staff access (grant / change roles / remove) lives on the owner-only Staff & roles
    # endpoints (apps/admin_api/staff_views.py), which record roles and audit them.

    @action(detail=True, methods=["post"])
    def reset_password(self, request, pk=None):
        """Reset user password"""
        user = self.get_object()
        if denied := self._staff_target_guard(request, user) or self._deleted_guard(user):
            return denied
        new_password = request.data.get("new_password", "")

        if not new_password:
            return Response(
                {"error": "new_password is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            validate_password(new_password, user)
            user.set_password(new_password)
            user.save()
            self._audit(request, user, "reset_password", f"Reset password for {user.username}")
            return Response(
                {"status": f"Password reset successful for {user.username}"}
            )
        except Exception as e:
            return Response({"error": str(e)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=["patch"])
    def update_user(self, request, pk=None):
        """Update user details: username, email, phone, first/last name, daily goal."""
        user = self.get_object()
        if denied := self._staff_target_guard(request, user) or self._deleted_guard(user):
            return denied
        before = {
            "username": user.username,
            "email": user.email,
            "phone_number": user.phone_number,
            "first_name": user.first_name,
            "last_name": user.last_name,
            "daily_goal": user.daily_goal,
        }

        # Update allowed fields
        username = request.data.get("username")
        email = request.data.get("email")
        phone_number = request.data.get("phone_number")

        errors = {}

        for name_field in ("first_name", "last_name"):
            value = request.data.get(name_field)
            if value is None:
                continue
            value = str(value).strip()
            if len(value) > 150:
                errors[name_field] = "Must be 150 characters or fewer"
            else:
                setattr(user, name_field, value)

        daily_goal = request.data.get("daily_goal")
        if daily_goal not in (None, ""):
            try:
                goal = int(daily_goal)
            except (TypeError, ValueError):
                errors["daily_goal"] = "Daily goal must be a whole number of steps"
            else:
                # Same range the app allows (apps/users/views.update_daily_goal).
                if goal < 1000 or goal > 60000:
                    errors["daily_goal"] = "Daily goal must be between 1,000 and 60,000 steps"
                else:
                    user.daily_goal = goal

        # Validate username if provided
        if username is not None and username != user.username:
            if not username or len(username.strip()) == 0:
                errors["username"] = "Username cannot be empty"
            elif User.objects.filter(username=username).exists():
                errors["username"] = "Username already exists"
            else:
                user.username = username

        # Validate email if provided
        if email is not None and email != user.email:
            if not email or len(email.strip()) == 0:
                errors["email"] = "Email cannot be empty"
            elif User.objects.filter(email=email).exists():
                errors["email"] = "Email already exists"
            else:
                user.email = email

        # Validate phone_number if provided
        if phone_number is not None and phone_number != user.phone_number:
            if not phone_number or len(phone_number.strip()) == 0:
                errors["phone_number"] = "Phone number is required"
            else:
                # Basic phone validation
                phone_clean = (
                    phone_number.replace("+", "").replace("-", "").replace(" ", "")
                )
                if not phone_clean.isdigit() or len(phone_clean) < 9:
                    errors["phone_number"] = "Phone number must be at least 9 digits"
                elif User.objects.filter(phone_number=phone_number).exists():
                    errors["phone_number"] = "Phone number already registered"
                else:
                    user.phone_number = phone_number

        if errors:
            return Response(errors, status=status.HTTP_400_BAD_REQUEST)

        user.save()
        changed = {
            key: {"old": old, "new": getattr(user, key)}
            for key, old in before.items()
            if getattr(user, key) != old
        }
        if changed:
            self._audit(request, user, "update", f"Updated details for {user.username}", changed)
        serializer = AdminUserSerializer(user)
        return Response(serializer.data)

    # The old reset_steps (zeroing the lifetime counters) is replaced by per-day step
    # corrections with recompute: correct_steps below (apps/steps/corrections.py).

    @action(detail=False, methods=["patch"], url_path="me")
    def update_me(self, request):
        """Update the current admin profile through the users endpoint."""
        serializer = AdminProfileSerializer(
            request.user,
            data=request.data,
            partial=True,
            context={"request": request},
        )
        serializer.is_valid(raise_exception=True)
        admin = serializer.save()

        from apps.admin_api.models import AuditLog

        AuditLog.log_action(
            admin=request.user,
            action="update",
            resource_type="user",
            resource_id=admin.id,
            resource_name=admin.username,
            description="Admin updated their own profile via admin user endpoint",
            changes={
                key: ("[file]" if hasattr(value, "name") else value)
                for key, value in serializer.validated_data.items()
            },
            request=request,
        )

        return Response(serializer.data)

    @action(detail=True, methods=["delete"])
    def delete_user(self, request, pk=None):
        """
        Delete an account the safe way: anonymise it and remove personal data
        (apps/users/account_deletion.py). Wallet, payment and challenge records are kept,
        detached from the person, so nothing cascades and the books still balance.
        """
        user = self.get_object()
        if user.id == request.user.id:
            return Response({"error": "Cannot delete your own account"}, status=status.HTTP_400_BAD_REQUEST)
        deleted = self._deleted_guard(user)
        if deleted:
            return deleted

        from apps.users.account_deletion import AccountDeletionError, delete_account

        username = user.username
        try:
            delete_account(user, channel="admin")
        except AccountDeletionError as exc:
            return Response(
                {
                    "error": "This account can't be deleted yet.",
                    "code": exc.code,
                    "blockers": [{"code": b.code, "message": b.message} for b in exc.blockers],
                },
                status=status.HTTP_409_CONFLICT,
            )
        self._audit(request, user, "delete", f"Deleted account {username} (anonymised; money records kept)")
        return Response({"status": f"Account {username} has been deleted and anonymised"})

    # ── Admin console part A: user tools ────────────────────────────────────

    def _reason_required(self, request, minimum=5):
        reason = str(request.data.get("reason") or "").strip()[:500]
        if len(reason) < minimum:
            return None, Response(
                {"error": f"A reason of at least {minimum} characters is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return reason, None

    @action(detail=True, methods=["post"])
    def sign_out_everywhere(self, request, pk=None):
        """Revoke every refresh token and end every app session of the user."""
        user = self.get_object()
        if denied := self._staff_target_guard(request, user) or self._deleted_guard(user):
            return denied
        from apps.users.account_deletion import _revoke_all_tokens

        revoked = _revoke_all_tokens(user)
        self._audit(request, user, "sign_out", f"Signed {user.username} out everywhere", {"tokens_revoked": revoked})
        return Response({"status": f"{user.username} was signed out on every device.", "tokens_revoked": revoked})

    @action(detail=True, methods=["post"])
    def unlock_login(self, request, pk=None):
        """Clear django-axes failed-login lockouts for the account."""
        user = self.get_object()
        if denied := self._staff_target_guard(request, user) or self._deleted_guard(user):
            return denied
        from axes.models import AccessAttempt
        from axes.utils import reset

        names = {user.username, user.email}
        attempts = AccessAttempt.objects.filter(username__in=names).count()
        for name in names:
            if name:
                reset(username=name)
        self._audit(request, user, "unlock", f"Cleared sign-in lockout for {user.username}", {"attempt_rows": attempts})
        return Response({"status": f"Sign-in lockout cleared for {user.username}.", "cleared": attempts})

    @action(detail=True, methods=["post"])
    def message(self, request, pk=None):
        """Open a support conversation to the user (they see it in Support in the app and can reply)."""
        from apps.admin_api.models import SupportTicket, SupportTicketMessage

        user = self.get_object()
        if denied := self._deleted_guard(user):
            return denied
        subject = str(request.data.get("subject") or "").strip()[:255]
        text = str(request.data.get("message") or "").strip()
        category = request.data.get("category") or "general"
        if category not in {c for c, _ in SupportTicket.CATEGORY_CHOICES}:
            category = "general"
        if not subject or len(text) < 2:
            return Response({"error": "A subject and a message are required."}, status=status.HTTP_400_BAD_REQUEST)
        if len(text) > 5000:
            return Response({"error": "The message must be 5,000 characters or fewer."}, status=status.HTTP_400_BAD_REQUEST)
        with db_transaction.atomic():
            ticket = SupportTicket.objects.create(
                user=user, subject=subject, category=category,
                message="Message from the Step2Win support team.",
                status="in_progress", priority="medium", assigned_to=request.user,
            )
            SupportTicketMessage.objects.create(
                ticket=ticket, sender=request.user, sender_username=request.user.username, is_admin=True, message=text,
            )
        self._audit(request, user, "message", f"Messaged {user.username}: {subject}", {"ticket_id": ticket.id})
        return Response({"status": "Message sent.", "ticket_id": ticket.id}, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def reset_device(self, request, pk=None):
        """Deactivate one step-tracking device, or reset the whole binding.

        mode=deactivate + registration_id: that device stops counting (the user must bind
        again from it). mode=reset: every registration is deactivated, the account's bound
        device is cleared and the 24 h switch cooldown is lifted, so the user can bind a new
        phone now (e.g. a lost or replaced phone). Step history is not touched."""
        from django.core.cache import cache

        from apps.steps.models import DeviceRegistration

        user = self.get_object()
        if denied := self._staff_target_guard(request, user) or self._deleted_guard(user):
            return denied
        reason, err = self._reason_required(request)
        if err:
            return err
        mode = request.data.get("mode") or "reset"
        if mode == "deactivate":
            reg = DeviceRegistration.objects.filter(user=user, id=request.data.get("registration_id")).first()
            if reg is None:
                return Response({"error": "Device not found for this user."}, status=status.HTTP_404_NOT_FOUND)
            with db_transaction.atomic():
                DeviceRegistration.objects.filter(pk=reg.pk).update(is_active=False, updated_at=timezone.now())
                if user.device_id and user.device_id == reg.device_id:
                    User.objects.filter(id=user.id).update(device_id=None)
            changes = {"registration_id": str(reg.id), "platform": reg.platform}
            desc = f"Deactivated a {reg.platform} device of {user.username}"
        elif mode == "reset":
            with db_transaction.atomic():
                n = DeviceRegistration.objects.filter(user=user, is_active=True).update(
                    is_active=False, updated_at=timezone.now()
                )
                User.objects.filter(id=user.id).update(device_id=None)
            cache.delete(f"device-rebind:{user.id}")
            changes = {"deactivated": n, "cooldown_cleared": True}
            desc = f"Reset the device binding of {user.username}"
        else:
            return Response({"error": "mode must be deactivate or reset"}, status=status.HTTP_400_BAD_REQUEST)
        changes["reason"] = reason
        from apps.admin_api.models import AuditLog

        AuditLog.log_action(
            admin=request.user, action="device_reset", resource_type="user", resource_id=user.id,
            resource_name=user.username, description=desc, changes=changes, request=request,
        )
        return Response({"status": desc, **{k: v for k, v in changes.items() if k != "reason"}})

    @action(detail=True, methods=["post"])
    def adjust_xp(self, request, pk=None):
        """Add or remove XP through an XPEvent ("admin_adjustment"); never below 0 total."""
        user = self.get_object()
        if denied := self._deleted_guard(user):
            return denied
        reason, err = self._reason_required(request)
        if err:
            return err
        try:
            amount = int(request.data.get("amount"))
        except (TypeError, ValueError):
            return Response({"error": "amount must be a whole number"}, status=status.HTTP_400_BAD_REQUEST)
        if amount == 0 or abs(amount) > 10000:
            return Response({"error": "amount must be between -10,000 and 10,000 and not 0"}, status=status.HTTP_400_BAD_REQUEST)
        xp, _ = UserXP.objects.get_or_create(user=user)
        before = xp.total_xp
        if amount < 0 and before + amount < 0:
            return Response(
                {"error": f"The user has only {before} XP; you can remove at most that."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        event = XPEvent.objects.create(
            user=user, event_type="admin_adjustment", amount=amount, description=reason[:255],
            metadata={"admin": request.user.username},
        )
        xp.refresh_from_db()
        self._audit(
            request, user, "xp_adjust", f"{'Added' if amount > 0 else 'Removed'} {abs(amount)} XP for {user.username}",
            {"xp": {"old": before, "new": xp.total_xp}, "xp_event_id": event.id, "level": xp.level},
        )
        return Response({"status": "ok", "total_xp": xp.total_xp, "level": xp.level, "xp_event_id": event.id})

    @action(detail=True, methods=["post"])
    def revoke_badge(self, request, pk=None):
        """Take a badge back from the user (the badge definition stays)."""
        user = self.get_object()
        reason, err = self._reason_required(request)
        if err:
            return err
        ub = UserBadge.objects.filter(user=user, badge_id=request.data.get("badge_id")).select_related("badge").first()
        if ub is None:
            return Response({"error": "The user does not hold this badge."}, status=status.HTTP_404_NOT_FOUND)
        name, earned = ub.badge.name, ub.earned_at
        ub.delete()
        self._audit(
            request, user, "revoke", f"Revoked badge {name} from {user.username}",
            {"badge_id": ub.badge_id, "badge": name, "earned_at": earned.isoformat() if earned else None},
        )
        return Response({"status": f"Badge {name} revoked."})

    @action(detail=True, methods=["post"])
    def correct_steps(self, request, pk=None):
        """Set / void / clear a correction of one day's steps, with recompute (apps/steps/corrections.py)."""
        from datetime import date as date_cls

        from apps.steps.corrections import StepCorrectionError, correct_day

        user = self.get_object()
        if denied := self._deleted_guard(user):
            return denied
        try:
            day = date_cls.fromisoformat(str(request.data.get("date") or ""))
        except ValueError:
            return Response({"error": "date must be YYYY-MM-DD"}, status=status.HTTP_400_BAD_REQUEST)
        try:
            result = correct_day(
                user=user, day=day, kind=request.data.get("kind"), steps=request.data.get("steps"),
                reason=request.data.get("reason"), admin=request.user,
            )
        except StepCorrectionError as exc:
            return Response({"error": exc.message, "code": exc.code}, status=exc.status_code)
        from apps.admin_api.models import AuditLog

        AuditLog.log_action(
            admin=request.user, action="steps_correction", resource_type="user", resource_id=user.id,
            resource_name=user.username,
            description=f"{ {'set': 'Set', 'void': 'Voided', 'clear': 'Removed the correction of'}[result['kind']] } steps for {user.username} on {result['date']}",
            changes={**result, "reason": str(request.data.get("reason") or "")[:500]}, request=request,
        )
        return Response(result)

    @action(detail=True, methods=["get"])
    def records(self, request, pk=None):
        """Read-only records for the drawer: consents, legal acceptances, change history
        (django-auditlog), sign-in lockout, step corrections, badges and recent XP."""
        from auditlog.models import LogEntry
        from axes.models import AccessAttempt
        from django.contrib.contenttypes.models import ContentType

        from apps.legal.models import UserDocumentAck
        from apps.privacy.models import Consent
        from apps.steps.corrections import correction_row
        from apps.steps.models import StepCorrection

        user = self.get_object()
        ct = ContentType.objects.get_for_model(User)
        entries = LogEntry.objects.filter(content_type=ct, object_pk=str(user.pk)).select_related("actor").order_by("-timestamp")[:50]
        limit = int(getattr(settings, "AXES_FAILURE_LIMIT", 5))
        attempts = AccessAttempt.objects.filter(username__in=[user.username, user.email])
        xp = UserXP.objects.filter(user=user).first()
        return Response(
            {
                "consents": [
                    {"id": c.id, "purpose": c.purpose, "granted": c.granted, "version": c.version,
                     "source": c.source, "app_version": c.app_version, "created_at": c.created_at.isoformat()}
                    for c in Consent.objects.filter(user=user).order_by("-created_at")[:100]
                ],
                "legal_acks": [
                    {"id": a.id, "document": a.document.title, "document_type": a.document.document_type,
                     "version_seen": a.version_seen, "current_version": a.document.version,
                     "acknowledged_at": a.acknowledged_at.isoformat()}
                    for a in UserDocumentAck.objects.filter(user=user).select_related("document").order_by("-acknowledged_at")
                ],
                "change_history": [
                    {"id": e.id, "action": {0: "create", 1: "update", 2: "delete", 3: "access"}.get(e.action, str(e.action)),
                     "changes": e.changes_dict, "actor": e.actor.username if e.actor_id else None,
                     "timestamp": e.timestamp.isoformat()}
                    for e in entries
                ],
                "lockout": {
                    "locked": any(a.failures_since_start >= limit for a in attempts),
                    "failures": sum(a.failures_since_start for a in attempts),
                    "limit": limit,
                },
                "step_corrections": [
                    correction_row(c) for c in StepCorrection.objects.filter(user=user).select_related("created_by")[:50]
                ],
                "badges": [
                    {"badge_id": b.badge_id, "name": b.badge.name, "icon": b.badge.icon, "earned_at": b.earned_at.isoformat()}
                    for b in UserBadge.objects.filter(user=user).select_related("badge").order_by("-earned_at")
                ],
                "xp": {"total_xp": xp.total_xp if xp else 0, "level": xp.level if xp else 1},
                "xp_events": [
                    {"id": e.id, "event_type": e.event_type, "amount": e.amount, "description": e.description,
                     "created_at": e.created_at.isoformat()}
                    for e in XPEvent.objects.filter(user=user).order_by("-created_at")[:20]
                ],
            }
        )

    @action(detail=False, methods=["get"])
    def export(self, request):
        """CSV of the filtered user list (same filters as the list). No secrets: no
        password hashes, tokens, device ids or IP addresses."""
        import csv

        from django.http import HttpResponse

        qs = filter_users(User.objects.all(), request.query_params)[:20000]
        response = HttpResponse(content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="step2win-users-{timezone.localdate().isoformat()}.csv"'
        writer = csv.writer(response)
        cols = ["id", "username", "email", "phone_number", "first_name", "last_name", "status", "is_staff",
                "date_joined", "last_login", "wallet_balance", "locked_balance", "total_earned", "trust_score",
                "open_flags", "daily_goal", "current_streak"]
        writer.writerow(cols)
        n = 0
        for u in qs:
            status_label = "deleted" if u.deleted_at else ("active" if u.is_active else "banned")
            row = [u.id, u.username, u.email, u.phone_number, u.first_name, u.last_name, status_label, u.is_staff,
                   u.date_joined.isoformat() if u.date_joined else "", u.last_login.isoformat() if u.last_login else "",
                   u.wallet_balance, u.locked_balance, u.total_earned, getattr(u, "trust_value", ""),
                   getattr(u, "open_flags", ""), u.daily_goal, u.current_streak]
            # Neutralise spreadsheet formulas in user-controlled text.
            writer.writerow([f"'{v}" if isinstance(v, str) and v[:1] in ("=", "+", "-", "@") else v for v in row])
            n += 1
        from apps.admin_api.models import AuditLog

        AuditLog.log_action(
            admin=request.user, action="export", resource_type="user",
            description=f"Exported {n} users to CSV",
            changes={"filters": {k: v for k, v in request.query_params.items() if k not in ("page", "page_size")}, "rows": n},
            request=request,
        )
        return response

    @action(detail=False, methods=["get"])
    def user_stats(self, request):
        """Get overall user statistics"""
        total_users = User.objects.count()
        active_users = User.objects.filter(is_active=True).count()
        banned_users = User.objects.filter(is_active=False, deleted_at__isnull=True).count()
        staff_users = User.objects.filter(is_staff=True).count()

        new_users_24h = User.objects.filter(
            created_at__gte=timezone.now() - timedelta(hours=24)
        ).count()
        new_users_7d = User.objects.filter(
            created_at__gte=timezone.now() - timedelta(days=7)
        ).count()
        flagged_users = (
            User.objects.filter(fraud_flags__reviewed=False).distinct().count()
        )
        low_trust_users = User.objects.filter(trust_score__score__lte=40).count()

        return Response(
            {
                "total_users": total_users,
                "active_users": active_users,
                "banned_users": banned_users,
                "staff_users": staff_users,
                "new_users_24h": new_users_24h,
                "new_users_7d": new_users_7d,
                "flagged_users": flagged_users,
                "low_trust_users": low_trust_users,
            }
        )

    @action(detail=False, methods=["get"])
    def top_earners(self, request):
        """Get top earning users"""
        limit = int(request.query_params.get("limit", 10))
        top_users = User.objects.order_by("-total_earned")[:limit]
        serializer = AdminUserSerializer(top_users, many=True)
        return Response(serializer.data)

    @action(detail=False, methods=["get"])
    def top_xp_users(self, request):
        """Get top XP users"""
        limit = int(request.query_params.get("limit", 10))
        top_xp = UserXP.objects.order_by("-total_xp")[:limit]
        users = [xp.user for xp in top_xp]
        serializer = AdminUserSerializer(users, many=True)
        return Response(serializer.data)


class AdminChallengeViewSet(NoDefaultWritesMixin, viewsets.ModelViewSet):
    """
    Admin challenge management endpoint
    """

    queryset = Challenge.objects.all()
    serializer_class = AdminChallengeSerializer
    permission_classes = [permissions.IsAuthenticated, StaffActionPermission]
    staff_perms = {
        "*": "console.view",
        "approve_challenge": "challenges.manage",
        "reject_challenge": "challenges.manage",
        "cancel_challenge": "challenges.manage",
        "set_featured": "challenges.manage",
        "update_challenge": "challenges.manage",
        "delete_challenge": "challenges.manage",
        "bulk_cancel": "challenges.manage",
        "bulk_delete": "challenges.manage",
        "set_archived": "challenges.manage",
        "create_platform": "challenges.platform",
        "remove_participant": "challenges.disqualify",
    }
    filterset_fields = ["status", "creator"]
    pagination_class = AdminPageNumberPagination

    def get_queryset(self):
        qs = super().get_queryset().select_related("creator")
        if self.action != "list":
            return qs
        params = self.request.query_params
        status_param = params.get("status")
        if status_param in {"pending", "active", "completed", "cancelled"}:
            qs = qs.filter(status=status_param)
        search = (params.get("search") or "").strip()
        if search:
            qs = qs.filter(
                Q(name__icontains=search)
                | Q(creator__username__icontains=search)
                | Q(invite_code__iexact=search)
            )
        if params.get("featured") == "true":
            qs = qs.filter(is_featured=True)
        if params.get("platform") == "true":
            qs = qs.filter(is_platform_challenge=True)
        archived = params.get("archived")
        if archived == "true":
            qs = qs.filter(is_archived=True)
        elif archived == "false":
            qs = qs.filter(is_archived=False)
        ordering = params.get("ordering") or "-created_at"
        if ordering.lstrip("-") not in {
            "created_at",
            "start_date",
            "end_date",
            "total_pool",
            "entry_fee",
            "name",
            "milestone",
        }:
            ordering = "-created_at"
        return qs.order_by(ordering, "-id")

    def _audit(self, request, challenge, action_name, description, changes=None):
        from apps.admin_api.models import AuditLog

        AuditLog.log_action(
            admin=request.user,
            action=action_name,
            resource_type="challenge",
            resource_id=challenge.id,
            resource_name=challenge.name,
            description=description,
            changes=changes,
            request=request,
        )

    @action(detail=True, methods=["post"])
    def approve_challenge(self, request, pk=None):
        """Approve a pending challenge"""
        challenge = self.get_object()
        if challenge.status != "pending":
            return Response(
                {"error": "Challenge is not pending"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        challenge.status = "active"
        # The clock starts at approval: keep the original length, starting today.
        today = timezone.localdate()
        if challenge.start_date and challenge.start_date < today:
            length = challenge.end_date - challenge.start_date
            challenge.start_date = today
            challenge.end_date = today + length
        challenge.save()
        self._audit(request, challenge, "approve", f"Approved challenge {challenge.name}", {"status": {"old": "pending", "new": "active"}})
        return Response({"status": "Challenge approved"})

    @action(detail=True, methods=["post"])
    def reject_challenge(self, request, pk=None):
        """Reject a pending challenge"""
        challenge = self.get_object()
        if challenge.status != "pending":
            return Response(
                {"error": "Only pending challenges can be rejected"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        reason = str(request.data.get("reason") or "").strip()[:500] or "No reason provided"
        # Existing cancel path: marks it cancelled and refunds every entry.
        from apps.challenges.services import cancel_challenge as cancel_and_refund

        if not cancel_and_refund(challenge, reason=f"Not approved: {reason}"):
            return Response(
                {"error": "Only pending challenges can be rejected"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        challenge.refresh_from_db()
        self._audit(request, challenge, "reject", f"Rejected challenge {challenge.name}", {"status": {"old": "pending", "new": "cancelled"}, "reason": reason})
        return Response({"status": f"Challenge rejected (cancelled). Reason: {reason}"})

    @action(detail=True, methods=["post"])
    def cancel_challenge(self, request, pk=None):
        """Cancel an active challenge"""
        challenge = self.get_object()
        if challenge.status not in ["pending", "active"]:
            return Response(
                {"error": "Can only cancel pending or active challenges"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        old_status = challenge.status
        reason = str(request.data.get("reason") or "").strip()[:500]
        # Cancel through the shared service so every entry is refunded to the
        # participant's wallet (with a ledger row) and locked balances are released.
        from apps.challenges.services import cancel_challenge as cancel_and_refund

        if not cancel_and_refund(challenge, reason=f"Cancelled by admin: {reason}" if reason else "Cancelled by admin"):
            return Response(
                {"error": "Can only cancel pending or active challenges"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        challenge.refresh_from_db()
        self._audit(
            request,
            challenge,
            "cancel",
            f"Cancelled challenge {challenge.name}",
            {"status": {"old": old_status, "new": "cancelled"}, **({"reason": reason} if reason else {})},
        )
        return Response({"status": "Challenge cancelled"})

    @action(detail=True, methods=["post"])
    def set_featured(self, request, pk=None):
        """Feature or unfeature a public challenge in discovery."""
        challenge = self.get_object()
        featured = bool(request.data.get("featured"))
        if featured and (challenge.is_private or challenge.status not in ["pending", "active"]):
            return Response(
                {"error": "Only public pending or active challenges can be featured"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        old = challenge.is_featured
        challenge.is_featured = featured
        if not featured:
            challenge.featured_until = None
        challenge.save(update_fields=["is_featured", "featured_until", "updated_at"])
        self._audit(
            request,
            challenge,
            "update",
            f"{'Featured' if featured else 'Unfeatured'} challenge {challenge.name}",
            {"is_featured": {"old": old, "new": featured}},
        )
        return Response(AdminChallengeSerializer(challenge).data)

    @action(detail=True, methods=["patch"])
    def update_challenge(self, request, pk=None):
        """Update challenge details"""
        challenge = self.get_object()

        # Update allowed fields
        name = request.data.get("name")
        milestone = request.data.get("milestone")
        max_participants = request.data.get("max_participants")
        end_date = request.data.get("end_date")

        # Changing the goal or end date of a live challenge people already paid into
        # changes who qualifies: not allowed once there are participants.
        live_with_entries = challenge.status in ("pending", "active") and challenge.participants.exists()
        if live_with_entries and (
            (milestone is not None and int(milestone) != challenge.milestone)
            or (end_date and str(end_date) != str(challenge.end_date))
        ):
            return Response(
                {
                    "error": "People have already joined this challenge, so its goal and end date can't change. "
                    "Cancel it (entries are refunded) and create a new one instead.",
                    "code": "challenge_has_entries",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        if max_participants is not None and int(max_participants) < challenge.participants.count():
            return Response(
                {"error": "Max participants can't be lower than the number already joined."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        before = {
            "name": challenge.name,
            "milestone": challenge.milestone,
            "max_participants": challenge.max_participants,
            "end_date": str(challenge.end_date),
        }

        if name:
            challenge.name = name

        if milestone is not None:
            challenge.milestone = int(milestone)

        if max_participants is not None:
            challenge.max_participants = int(max_participants)

        if end_date:
            challenge.end_date = end_date

        challenge.save()
        challenge.refresh_from_db()
        after = {
            "name": challenge.name,
            "milestone": challenge.milestone,
            "max_participants": challenge.max_participants,
            "end_date": str(challenge.end_date),
        }
        changes = {k: {"old": before[k], "new": after[k]} for k in before if before[k] != after[k]}
        if changes:
            from apps.admin_api.models import AuditLog

            AuditLog.log_action(
                admin=request.user, action="update", resource_type="challenge", resource_id=challenge.id,
                resource_name=challenge.name, description=f"Edited challenge {challenge.name}",
                changes=changes, request=request,
            )
        serializer = AdminChallengeSerializer(challenge)
        return Response(serializer.data)

    @action(detail=True, methods=["delete"])
    def delete_challenge(self, request, pk=None):
        """Delete challenge (hard delete)"""
        challenge = self.get_object()

        # Only cancelled challenges: pending/active must be cancelled first (entries
        # refunded), and completed ones keep their results and payouts.
        if challenge.status != "cancelled":
            return Response(
                {
                    "error": "Only cancelled challenges can be deleted. Cancel it first (entries are refunded); "
                    "completed challenges are kept for their results and payouts."
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        from django.db.models import ProtectedError

        from apps.admin_api.models import AuditLog

        challenge_name = challenge.name
        challenge_id = challenge.id
        try:
            challenge.delete()
        except ProtectedError:
            return Response(
                {"error": "This challenge has money records that must be kept, so it can't be deleted."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        AuditLog.log_action(
            admin=request.user, action="delete", resource_type="challenge", resource_id=challenge_id,
            resource_name=challenge_name, description=f"Deleted cancelled challenge {challenge_name}",
            request=request,
        )
        return Response(
            {"status": f"Challenge {challenge_name} has been permanently deleted"}
        )

    @action(detail=False, methods=["post"])
    def bulk_cancel(self, request):
        """Bulk cancel challenges"""
        challenge_ids = request.data.get("challenge_ids", [])

        if not challenge_ids:
            return Response(
                {"error": "challenge_ids is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        challenges = Challenge.objects.filter(
            id__in=challenge_ids, status__in=["pending", "active"]
        )
        # One by one through the shared service so each challenge's entries are refunded.
        from apps.challenges.services import cancel_challenge as cancel_and_refund

        reason = str(request.data.get("reason") or "").strip()[:500]
        count = 0
        for challenge in challenges:
            old_status = challenge.status
            if cancel_and_refund(challenge, reason=f"Cancelled by admin: {reason}" if reason else "Bulk cancelled by admin"):
                count += 1
                self._audit(
                    request, challenge, "cancel", f"Bulk cancelled challenge {challenge.name}",
                    {"status": {"old": old_status, "new": "cancelled"}, **({"reason": reason} if reason else {})},
                )

        return Response({"status": f"{count} challenge(s) cancelled", "cancelled": count})

    @action(detail=True, methods=["post"])
    def set_archived(self, request, pk=None):
        """Hide (or show again) a completed / cancelled challenge in customer lists.
        Participants keep it in their own history; nothing is deleted."""
        challenge = self.get_object()
        archived = bool(request.data.get("archived", True))
        if archived and challenge.status not in ("completed", "cancelled"):
            return Response(
                {"error": "Only completed or cancelled challenges can be archived."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        old = challenge.is_archived
        challenge.is_archived = archived
        challenge.archived_at = timezone.now() if archived else None
        challenge.save(update_fields=["is_archived", "archived_at", "updated_at"])
        self._audit(
            request, challenge, "archive", f"{'Archived' if archived else 'Unarchived'} challenge {challenge.name}",
            {"is_archived": {"old": old, "new": archived}},
        )
        return Response(AdminChallengeSerializer(challenge).data)

    @action(detail=False, methods=["post"])
    def create_platform(self, request):
        """Create a platform (sponsored) challenge, live now, open to everyone.

        Funding: ``platform_bonus_kes`` is added to the payout pool at settlement
        (Challenge.net_pool) and recorded then as a negative payments.PlatformRevenue row
        ("platform_bonus"), i.e. paid out of platform revenue. It is spent only if someone
        qualifies; if nobody does (entries refunded) or the challenge is cancelled, no
        bonus leaves the platform. A bonus needs the finance.adjust permission too."""
        from datetime import date as date_cls

        from apps.admin_api.models import SystemSettings
        from apps.admin_api.roles import has_perm

        data = request.data
        errors = {}
        name = str(data.get("name") or "").strip()[:200]
        if len(name) < 3:
            errors["name"] = "Give the challenge a name (3+ characters)."
        try:
            milestone = int(data.get("milestone"))
        except (TypeError, ValueError):
            milestone = 0
        settings_obj = SystemSettings.load()
        if not (settings_obj.min_challenge_milestone <= milestone <= settings_obj.max_challenge_milestone):
            errors["milestone"] = (
                f"Between {settings_obj.min_challenge_milestone:,} and {settings_obj.max_challenge_milestone:,} steps."
            )
        try:
            entry_fee = Decimal(str(data.get("entry_fee", "0") or "0")).quantize(Decimal("0.01"))
            bonus = Decimal(str(data.get("platform_bonus_kes", "0") or "0")).quantize(Decimal("0.01"))
        except Exception:
            entry_fee, bonus = Decimal("-1"), Decimal("-1")
        if entry_fee < 0 or entry_fee > settings_obj.max_challenge_entry_fee:
            errors["entry_fee"] = f"Between 0 and {settings_obj.max_challenge_entry_fee}."
        if bonus < 0 or bonus > Decimal("1000000"):
            errors["platform_bonus_kes"] = "Between 0 and 1,000,000."
        today = timezone.localdate()
        try:
            end_date = date_cls.fromisoformat(str(data.get("end_date") or ""))
        except ValueError:
            end_date = None
        if end_date is None or end_date <= today or (end_date - today).days > 90:
            errors["end_date"] = "An end date after today, at most 90 days away."
        try:
            max_participants = int(data.get("max_participants") or 100)
        except (TypeError, ValueError):
            max_participants = 0
        if not (2 <= max_participants <= 1000):
            errors["max_participants"] = "Between 2 and 1,000."
        if errors:
            return Response(errors, status=status.HTTP_400_BAD_REQUEST)
        if bonus > 0 and not has_perm(request.user, "finance.adjust"):
            return Response(
                {"error": "A platform bonus spends platform money: it needs the finance role as well."},
                status=status.HTTP_403_FORBIDDEN,
            )
        challenge = Challenge.objects.create(
            name=name,
            description=str(data.get("description") or "").strip()[:2000],
            creator=request.user,
            milestone=milestone,
            entry_fee=entry_fee,
            max_participants=max_participants,
            status="active",
            start_date=today,
            end_date=end_date,
            is_private=False,
            is_public=True,
            is_featured=bool(data.get("is_featured")),
            is_platform_challenge=True,
            platform_bonus_kes=bonus,
            win_condition="proportional",
            payout_structure="proportional",
        )
        self._audit(
            request, challenge, "create", f"Created platform challenge {challenge.name}",
            {"entry_fee": str(entry_fee), "platform_bonus_kes": str(bonus), "milestone": milestone,
             "end_date": end_date.isoformat(), "max_participants": max_participants},
        )
        return Response(AdminChallengeSerializer(challenge).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"])
    def remove_participant(self, request, pk=None):
        """Disqualify / remove a participant from a live challenge.

        mode=refund: the entry fee goes back to their wallet (refund ledger row).
        mode=forfeit: the entry fee is kept by the platform (PlatformRevenue row
        "forfeited_entry"); their wallet is not credited. Either way the entry leaves the
        pool and their locked balance. Audited; the user gets an in-app notice."""
        from apps.admin_api.notices import notice_to_user
        from apps.payments.models import PlatformRevenue
        from apps.wallet.models import WalletTransaction as WT

        mode = request.data.get("mode")
        reason = str(request.data.get("reason") or "").strip()[:500]
        if mode not in ("refund", "forfeit"):
            return Response({"error": "mode must be refund or forfeit"}, status=status.HTTP_400_BAD_REQUEST)
        if len(reason) < 5:
            return Response({"error": "A reason of at least 5 characters is required."}, status=status.HTTP_400_BAD_REQUEST)
        with db_transaction.atomic():
            challenge = Challenge.objects.select_for_update().get(pk=self.get_object().pk)
            if challenge.status not in ("pending", "active"):
                return Response(
                    {"error": "Participants can only be removed from pending or live challenges."},
                    status=status.HTTP_409_CONFLICT,
                )
            participant = (
                Participant.objects.select_for_update().filter(challenge=challenge, user_id=request.data.get("user_id")).first()
            )
            if participant is None:
                return Response({"error": "That user is not in this challenge."}, status=status.HTTP_404_NOT_FOUND)
            user = User.objects.select_for_update().get(id=participant.user_id)
            fee = challenge.entry_fee
            steps = participant.steps
            before = user.wallet_balance
            user.locked_balance = max(Decimal("0.00"), user.locked_balance - fee)
            ledger = {}
            if mode == "refund":
                user.wallet_balance = before + fee
                user.save(update_fields=["wallet_balance", "locked_balance", "updated_at"])
                if fee > 0:
                    t = WT.objects.create(
                        user=user, type="refund", amount=fee, balance_before=before, balance_after=user.wallet_balance,
                        description=f"Removed from challenge: {challenge.name} (entry refunded)",
                        metadata={"challenge_id": challenge.id, "source": "admin_remove_participant", "reason": reason},
                    )
                    ledger["wallet_transaction_id"] = t.id
            else:
                user.save(update_fields=["locked_balance", "updated_at"])
                if fee > 0:
                    rev = PlatformRevenue.objects.create(
                        challenge=challenge, amount_kes=fee,
                        narration=f"Forfeited entry: {user.username} removed from {challenge.name}"[:255],
                        metadata={"kind": "forfeited_entry", "user_id": user.id, "reason": reason},
                    )
                    ledger["platform_revenue_id"] = rev.id
            challenge.total_pool = max(Decimal("0.00"), challenge.total_pool - fee)
            challenge.save(update_fields=["total_pool", "updated_at"])
            participant.delete()
        self._audit(
            request, challenge, "disqualify",
            f"Removed {user.username} from {challenge.name} ({'entry refunded' if mode == 'refund' else 'entry forfeited'})",
            {"user_id": user.id, "username": user.username, "mode": mode, "entry_fee": str(fee), "steps": steps,
             "reason": reason, **ledger},
        )
        notice_to_user(
            user, request.user, "Challenge entry update",
            f"You have been removed from the challenge \"{challenge.name}\". "
            + (f"Your entry fee of KES {fee} is back in your wallet." if mode == "refund" and fee > 0 else "")
            + (" Your entry fee was not refunded." if mode == "forfeit" and fee > 0 else "")
            + f" Reason: {reason}",
            category="challenge", team="support",
        )
        return Response({"status": "removed", "mode": mode, **ledger})

    @action(detail=False, methods=["post"])
    def bulk_delete(self, request):
        """Bulk delete challenges"""
        challenge_ids = request.data.get("challenge_ids", [])

        if not challenge_ids:
            return Response(
                {"error": "challenge_ids is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Only cancelled challenges; completed ones keep their results and payouts.
        from django.db.models import ProtectedError

        from apps.admin_api.models import AuditLog

        count = 0
        for challenge in Challenge.objects.filter(id__in=challenge_ids, status="cancelled"):
            name, cid = challenge.name, challenge.id
            try:
                challenge.delete()
            except ProtectedError:
                continue
            count += 1
            AuditLog.log_action(
                admin=request.user, action="delete", resource_type="challenge", resource_id=cid,
                resource_name=name, description=f"Bulk deleted cancelled challenge {name}", request=request,
            )

        return Response({"status": f"{count} challenge(s) deleted"})

    @action(detail=False, methods=["get"])
    def challenge_stats(self, request):
        """Get challenge statistics"""
        total_challenges = Challenge.objects.count()
        live_challenges = Challenge.objects.filter(status="active").count()
        completed_challenges = Challenge.objects.filter(status="completed").count()
        total_entries = Participant.objects.count()
        total_prize_pool = Challenge.objects.aggregate(Sum("total_pool"))[
            "total_pool__sum"
        ] or Decimal("0.00")

        by_status = {
            row["status"]: row
            for row in Challenge.objects.order_by()
            .values("status")
            .annotate(n=Count("id"), pool=Sum("total_pool"))
        }

        return Response(
            {
                "total_challenges": total_challenges,
                "live_challenges": live_challenges,
                "completed_challenges": completed_challenges,
                "pending_challenges": by_status.get("pending", {}).get("n", 0),
                "cancelled_challenges": by_status.get("cancelled", {}).get("n", 0),
                "live_pool": str(by_status.get("active", {}).get("pool") or Decimal("0.00")),
                "pending_pool": str(by_status.get("pending", {}).get("pool") or Decimal("0.00")),
                "total_entries": total_entries,
                "total_prize_pool": str(total_prize_pool),
            }
        )

    @action(detail=True, methods=["get"])
    def results(self, request, pk=None):
        """Get challenge results and leaderboard"""
        from apps.admin_api.models import AuditLog

        challenge = self.get_object()
        results = (
            Participant.objects.filter(challenge=challenge)
            .select_related("user")
            .order_by("-steps", "joined_at")
        )

        data = {
            "challenge": AdminChallengeSerializer(challenge).data,
            "results": [
                {
                    "position": index + 1,
                    "user": r.user.username,
                    "user_id": r.user_id,
                    "steps": r.steps,
                    "qualified": r.qualified,
                    "rank": r.rank,
                    "payout": str(r.payout),
                    "joined_at": r.joined_at,
                }
                for index, r in enumerate(results)
            ],
            "audit": [
                {
                    "id": a.id,
                    "admin_username": a.admin_username,
                    "action": a.action,
                    "description": a.description,
                    "changes": a.changes,
                    "created_at": a.created_at,
                }
                for a in AuditLog.objects.filter(
                    resource_type="challenge", resource_id=challenge.id
                )[:30]
            ],
        }
        return Response(data)


class AdminTransactionViewSet(viewsets.ReadOnlyModelViewSet):
    """
    Admin transaction history endpoint
    """

    queryset = WalletTransaction.objects.all()
    serializer_class = AdminTransactionSerializer
    permission_classes = [permissions.IsAuthenticated, StaffActionPermission]
    staff_perms = {"*": "finance.view"}
    filterset_fields = ["user", "type"]

    @action(detail=False, methods=["get"])
    def transaction_stats(self, request):
        """Get transaction statistics"""
        transactions = WalletTransaction.objects.all()

        deposits = transactions.filter(type="deposit").aggregate(Sum("amount"))[
            "amount__sum"
        ] or Decimal("0.00")
        withdrawals = transactions.filter(type="withdrawal").aggregate(Sum("amount"))[
            "amount__sum"
        ] or Decimal("0.00")
        total_volume = deposits + withdrawals

        return Response(
            {
                "total_volume": str(total_volume),
                "deposits": str(deposits),
                "withdrawals": str(withdrawals),
                "total_transactions": transactions.count(),
            }
        )

    @action(detail=False, methods=["get"])
    def daily_volume(self, request):
        """Get daily transaction volume for last 30 days"""
        days = int(request.query_params.get("days", 30))

        daily_data = []
        for i in range(days):
            date = (timezone.now() - timedelta(days=i)).date()
            volume = WalletTransaction.objects.filter(
                created_at__date=date, type__in=["deposit", "withdrawal"]
            ).aggregate(Sum("amount"))["amount__sum"] or Decimal("0.00")

            daily_data.append(
                {
                    "date": date.isoformat(),
                    "volume": str(volume),
                }
            )

        return Response(daily_data)


class AdminBadgeViewSet(viewsets.ModelViewSet):
    """
    Admin badge management endpoint
    """

    queryset = Badge.objects.all()
    serializer_class = AdminBadgeSerializer
    permission_classes = [permissions.IsAuthenticated, StaffActionPermission]
    staff_perms = {
        "*": "console.view",
        "create": "content.badges",
        "update": "content.badges",
        "partial_update": "content.badges",
        "destroy": "content.badges",
        "retire": "content.badges",
        "award_to_user": "users.xp",
    }
    pagination_class = AdminPageNumberPagination

    def _audit(self, badge, action_name, description, changes=None):
        from apps.admin_api.models import AuditLog

        AuditLog.log_action(
            admin=self.request.user,
            action=action_name,
            resource_type="badge",
            resource_id=badge.id,
            resource_name=badge.name,
            description=description,
            changes=changes,
            request=self.request,
        )

    def perform_create(self, serializer):
        badge = serializer.save()
        self._audit(badge, "create", f"Created badge {badge.name}")

    def perform_update(self, serializer):
        badge = serializer.save()
        self._audit(
            badge,
            "update",
            f"Updated badge {badge.name}",
            {k: str(v) for k, v in serializer.validated_data.items()},
        )

    def destroy(self, request, *args, **kwargs):
        # Delete only a badge nobody holds (and no level reward uses); otherwise retire.
        badge = self.get_object()
        holders = UserBadge.objects.filter(badge=badge).count()
        from apps.gamification.models import LevelMilestone

        rewards = LevelMilestone.objects.filter(reward_badge=badge).count()
        if holders or rewards:
            return Response(
                {"error": f"{holders} people hold this badge. Retire it instead: they keep it, nobody new earns it.",
                 "holders": holders, "level_rewards": rewards},
                status=status.HTTP_409_CONFLICT,
            )
        self._audit(badge, "delete", f"Deleted badge {badge.name}")
        badge.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"])
    def retire(self, request, pk=None):
        """Retire (hide) or bring back a badge. Body: {retired: true|false}. Holders keep it."""
        badge = self.get_object()
        retired = request.data.get("retired", True)
        if not isinstance(retired, bool):
            return Response({"error": "retired must be true or false"}, status=status.HTTP_400_BAD_REQUEST)
        if badge.is_retired != retired:
            badge.is_retired = retired
            badge.retired_at = timezone.now() if retired else None
            badge.save(update_fields=["is_retired", "retired_at", "updated_at"])
            self._audit(badge, "retire" if retired else "restore",
                        f"{'Retired' if retired else 'Brought back'} badge {badge.name}",
                        {"is_retired": {"old": not retired, "new": retired},
                         "holders": UserBadge.objects.filter(badge=badge).count()})
        return Response(self.get_serializer(badge).data)

    @action(detail=True, methods=["post"])
    def award_to_user(self, request, pk=None):
        """Award badge to a user"""
        badge = self.get_object()
        user_id = request.data.get("user_id")

        if not user_id:
            return Response(
                {"error": "user_id is required"}, status=status.HTTP_400_BAD_REQUEST
            )

        try:
            user = User.objects.get(id=user_id)
            user_badge, created = UserBadge.objects.get_or_create(
                user=user, badge=badge
            )
            if created:
                from apps.admin_api.models import AuditLog

                AuditLog.log_action(
                    admin=request.user, action="award", resource_type="user", resource_id=user.id,
                    resource_name=user.username, description=f"Awarded badge {badge.name} to {user.username}",
                    changes={"badge_id": badge.id, "badge": badge.name,
                             "reason": str(request.data.get("reason") or "")[:500]},
                    request=request,
                )
            return Response(
                {
                    "status": "Badge awarded",
                    "user": user.username,
                    "badge": badge.name,
                    "created": created,
                }
            )
        except User.DoesNotExist:
            return Response(
                {"error": "User not found"}, status=status.HTTP_404_NOT_FOUND
            )

    @action(detail=False, methods=["get"])
    def badge_stats(self, request):
        """Get badge statistics"""
        badges = Badge.objects.all()

        stats = []
        for badge in badges:
            user_count = UserBadge.objects.filter(badge=badge).count()
            stats.append(
                {
                    "badge": badge.name,
                    "icon": badge.icon,
                    "users_earned": user_count,
                }
            )

        return Response(stats)


class AdminDashboardViewSet(viewsets.ViewSet):
    """
    Main dashboard statistics endpoint
    """

    permission_classes = [permissions.IsAuthenticated, StaffActionPermission]
    staff_perms = {"*": "console.view"}

    @extend_schema(responses={200: OpenApiTypes.OBJECT})
    @action(detail=False, methods=["get"])
    def overview(self, request):
        """Get complete dashboard overview with enhanced metrics for Vault-style UI"""
        from django.db.models import Count
        from django.db.models.functions import TruncDate

        def percent_change(current, previous):
            if previous <= 0:
                return 0.0
            return ((current - previous) / previous) * 100

        def build_daily_series(days_count, qs, value_key, sum_field=None):
            # Build a full day-by-day series to keep charts aligned and non-sparse.
            today = timezone.localdate()
            start_day = today - timedelta(days=days_count - 1)

            base_qs = qs.filter(created_at__date__gte=start_day)
            grouped = (
                base_qs.annotate(d=TruncDate("created_at"))
                .values("d")
                .annotate(value=Count("id") if sum_field is None else Sum(sum_field))
                .order_by("d")
            )

            by_day = {row["d"]: float(row["value"] or 0) for row in grouped}

            data = []
            for i in range(days_count):
                day = start_day + timedelta(days=i)
                data.append((day, by_day.get(day, 0.0)))
            return data

        days_param = int(request.query_params.get("days", 7))
        now = timezone.now()
        start = now - timedelta(days=days_param)
        prev_start = start - timedelta(days=days_param)  # Previous period for trends

        # ═══════════════════════════════════════════════════════════════════
        # USER METRICS
        # ═══════════════════════════════════════════════════════════════════
        total_users = User.objects.count()
        users_current = User.objects.filter(created_at__gte=start).count()
        users_previous = User.objects.filter(
            created_at__gte=prev_start, created_at__lt=start
        ).count()
        user_growth_pct = percent_change(users_current, users_previous)

        # User sparkline (last 7 days)
        user_spark = [
            int(value)
            for _, value in build_daily_series(7, User.objects.all(), value_key="users")
        ]

        # Recent users (last 6)
        recent_users_qs = User.objects.order_by("-created_at")[:6]
        recent_users = [
            {
                "id": u.id,
                "username": u.username,
                "email": u.email,
                "joined": u.created_at.strftime("%b %d") if u.created_at else "N/A",
            }
            for u in recent_users_qs
        ]

        # ═══════════════════════════════════════════════════════════════════
        # REVENUE METRICS
        # ═══════════════════════════════════════════════════════════════════
        deposits_current = WalletTransaction.objects.filter(
            type="deposit", created_at__gte=start
        ).aggregate(total=Sum("amount"))["total"] or Decimal("0.00")

        deposits_previous = WalletTransaction.objects.filter(
            type="deposit", created_at__gte=prev_start, created_at__lt=start
        ).aggregate(total=Sum("amount"))["total"] or Decimal("0.00")

        # Platform fees are recorded in payments.PlatformRevenue when a
        # challenge is finalised (no WalletTransaction type="fee" is written).
        from apps.payments.models import PlatformRevenue

        fees_current = PlatformRevenue.objects.filter(
            collected_at__gte=start
        ).aggregate(total=Sum("amount_kes"))["total"] or Decimal("0.00")

        fees_previous = PlatformRevenue.objects.filter(
            collected_at__gte=prev_start, collected_at__lt=start
        ).aggregate(total=Sum("amount_kes"))["total"] or Decimal("0.00")

        revenue_growth_pct = percent_change(float(fees_current), float(fees_previous))

        # Prefer explicit fee transactions as true platform revenue.
        revenue_kes = float(fees_current)

        # Revenue sparkline (last 7 days)
        revenue_spark = [
            float(value)
            for _, value in build_daily_series(
                7,
                WalletTransaction.objects.filter(type="fee"),
                value_key="fees",
                sum_field="amount",
            )
        ]

        # ═══════════════════════════════════════════════════════════════════
        # CHALLENGE METRICS
        # ═══════════════════════════════════════════════════════════════════
        challenges_active = Challenge.objects.filter(status="active").count()
        challenges_pending = Challenge.objects.filter(status="pending").count()
        challenges_completed = Challenge.objects.filter(status="completed").count()

        challenges_current = Challenge.objects.filter(created_at__gte=start).count()
        challenges_previous = Challenge.objects.filter(
            created_at__gte=prev_start, created_at__lt=start
        ).count()

        # Challenge sparkline
        challenge_spark = [
            int(value)
            for _, value in build_daily_series(
                7, Challenge.objects.all(), value_key="challenges"
            )
        ]

        challenge_growth_pct = percent_change(challenges_current, challenges_previous)

        # ═══════════════════════════════════════════════════════════════════
        # WITHDRAWAL METRICS
        # ═══════════════════════════════════════════════════════════════════
        # Live model is payments.WithdrawalRequest (wallet.Withdrawal is legacy
        # and no longer written), so the overview matches the review queue.
        pending_withdrawals_qs = WithdrawalRequest.objects.filter(
            status="pending_review"
        ).select_related("user")
        pending_withdrawals_count = pending_withdrawals_qs.count()
        pending_withdrawals_amount = pending_withdrawals_qs.aggregate(
            total=Sum("amount_kes")
        )["total"] or Decimal("0.00")

        # Pending withdrawals list (top 5 for dashboard)
        pending_list = []
        for w in pending_withdrawals_qs.order_by("-created_at")[:5]:
            pending_list.append(
                {
                    "id": str(w.id),
                    "username": w.user.username,
                    "amount": float(w.amount_kes),
                    "phone": w.destination_display,
                    "created_at": (
                        w.created_at.strftime("%b %d, %H:%M") if w.created_at else "N/A"
                    ),
                }
            )

        # ═══════════════════════════════════════════════════════════════════
        # CHART DATA
        # ═══════════════════════════════════════════════════════════════════

        # Revenue chart (deposits vs withdrawals per day)
        deposits_daily = dict(
            build_daily_series(
                days_param,
                WalletTransaction.objects.filter(type="deposit"),
                value_key="deposits",
                sum_field="amount",
            )
        )
        withdrawals_daily = dict(
            build_daily_series(
                days_param,
                WalletTransaction.objects.filter(type="withdrawal"),
                value_key="withdrawals",
                sum_field="amount",
            )
        )

        revenue_chart = []
        start_day = timezone.localdate() - timedelta(days=days_param - 1)
        for i in range(days_param):
            day = start_day + timedelta(days=i)
            revenue_chart.append(
                {
                    "date": day.strftime("%b %d"),
                    "deposits": float(deposits_daily.get(day, 0.0)),
                    "withdrawals": float(withdrawals_daily.get(day, 0.0)),
                }
            )

        # User signup chart
        user_chart = [
            {"date": day.strftime("%b %d"), "users": int(value)}
            for day, value in build_daily_series(
                days_param, User.objects.all(), value_key="users"
            )
        ]

        # Steps chart - aggregate from HealthRecord
        step_chart = []
        step_start_day = timezone.localdate() - timedelta(days=days_param - 1)
        steps_by_day_qs = (
            HealthRecord.objects.filter(date__gte=step_start_day)
            .values("date")
            .annotate(total=Sum("steps"))
            .order_by("date")
        )
        steps_by_day = {row["date"]: int(row["total"] or 0) for row in steps_by_day_qs}
        for i in range(days_param):
            day = step_start_day + timedelta(days=i)
            step_chart.append(
                {
                    "date": day.strftime("%b %d"),
                    "steps": steps_by_day.get(day, 0),
                }
            )

        # ═══════════════════════════════════════════════════════════════════
        # GAMIFICATION METRICS (legacy support)
        # ═══════════════════════════════════════════════════════════════════
        week_ago = now - timedelta(days=7)
        month_ago = now - timedelta(days=30)

        active_users_week = (
            HealthRecord.objects.filter(date__gte=week_ago.date())
            .values("user")
            .distinct()
            .count()
        )

        new_users_week = User.objects.filter(created_at__gte=week_ago).count()

        week_deposits = WalletTransaction.objects.filter(
            type="deposit", created_at__gte=week_ago
        ).aggregate(Sum("amount"))["amount__sum"] or Decimal("0.00")

        week_withdrawals = WalletTransaction.objects.filter(
            type="withdrawal", created_at__gte=week_ago
        ).aggregate(Sum("amount"))["amount__sum"] or Decimal("0.00")

        total_xp_distributed = (
            XPEvent.objects.filter(created_at__gte=week_ago).aggregate(Sum("amount"))[
                "amount__sum"
            ]
            or 0
        )

        completed_challenges_month = Challenge.objects.filter(
            status="completed", end_date__gte=month_ago.date()
        ).count()

        # ═══════════════════════════════════════════════════════════════════
        # RESPONSE
        # ═══════════════════════════════════════════════════════════════════
        return Response(
            {
                # Enhanced metrics for Vault UI
                "total_users": total_users,
                "user_growth_pct": round(user_growth_pct, 1),
                "user_spark": user_spark,
                "revenue_kes": round(revenue_kes),
                "revenue_growth_pct": round(revenue_growth_pct, 1),
                "revenue_spark": revenue_spark,
                "live_challenges": challenges_active,
                "challenge_growth_pct": round(challenge_growth_pct, 1),
                "challenge_spark": challenge_spark,
                "pending_withdrawals_count": pending_withdrawals_count,
                "pending_withdrawals_amount": float(pending_withdrawals_amount),
                # Challenge breakdown
                "challenges_active": challenges_active,
                "challenges_pending": challenges_pending,
                "challenges_completed": challenges_completed,
                # Charts
                "revenue_chart": revenue_chart,
                "user_chart": user_chart,
                "step_chart": step_chart,
                # Activity feeds
                "recent_users": recent_users,
                "pending_withdrawals_list": pending_list,
                # Legacy support (backward compatibility)
                "users": {
                    "total": total_users,
                    "active_week": active_users_week,
                    "new_week": new_users_week,
                },
                "finance": {
                    "week_deposits": str(week_deposits),
                    "week_withdrawals": str(week_withdrawals),
                    "pending_withdrawals": str(pending_withdrawals_amount),
                },
                "challenges": {
                    "live": challenges_active,
                    "completed_month": completed_challenges_month,
                },
                "gamification": {
                    "xp_distributed_week": total_xp_distributed,
                },
                "timestamp": now.isoformat(),
            }
        )

    @extend_schema(responses={200: OpenApiTypes.OBJECT})
    @action(detail=False, methods=["get"])
    def revenue_chart(self, request):
        """Get revenue data for chart"""
        from apps.admin_api.models import SystemSettings

        days = int(request.query_params.get("days", 30))
        fee_percentage = Decimal(str(SystemSettings.load().platform_fee_percentage))

        chart_data = []
        for i in range(days):
            date = (timezone.now() - timedelta(days=i)).date()

            deposits = WalletTransaction.objects.filter(
                type="deposit", created_at__date=date
            ).aggregate(Sum("amount"))["amount__sum"] or Decimal("0.00")

            withdrawals = WalletTransaction.objects.filter(
                type="withdrawal", created_at__date=date
            ).aggregate(Sum("amount"))["amount__sum"] or Decimal("0.00")

            revenue = (deposits - withdrawals) * (fee_percentage / Decimal("100"))

            chart_data.append(
                {
                    "date": date.isoformat(),
                    "deposits": str(deposits),
                    "withdrawals": str(withdrawals),
                    "revenue": str(revenue),
                }
            )

        return Response(chart_data)


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff())
def get_system_settings(request):
    """Get current system settings"""
    from apps.admin_api.models import SystemSettings
    from apps.admin_api.serializers import SystemSettingsSerializer

    settings = SystemSettings.load()
    serializer = SystemSettingsSerializer(settings)
    return Response(serializer.data)


@extend_schema(
    request=OpenApiTypes.OBJECT,
    responses={200: OpenApiTypes.OBJECT, 400: OpenApiTypes.OBJECT},
)
@api_view(["POST"])
@permission_classes(staff("settings.system"))
def update_system_settings(request):
    """Update system settings"""
    from apps.admin_api.models import AuditLog, SystemSettings
    from apps.admin_api.serializers import SystemSettingsSerializer

    settings = SystemSettings.load()
    serializer = SystemSettingsSerializer(data=request.data, partial=True)

    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    merged_settings = {
        "min_challenge_entry_fee": settings.min_challenge_entry_fee,
        "max_challenge_entry_fee": settings.max_challenge_entry_fee,
        "min_challenge_milestone": settings.min_challenge_milestone,
        "max_challenge_milestone": settings.max_challenge_milestone,
        "challenge_milestones": list(settings.challenge_milestones or []),
    }
    merged_settings.update(serializer.validated_data)

    if Decimal(str(merged_settings["min_challenge_entry_fee"])) >= Decimal(
        str(merged_settings["max_challenge_entry_fee"])
    ):
        return Response(
            {"max_challenge_entry_fee": "Must be more than the lowest entry fee"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    min_milestone = int(merged_settings["min_challenge_milestone"])
    max_milestone = int(merged_settings["max_challenge_milestone"])
    milestones = merged_settings.get("challenge_milestones") or []
    out_of_range = [m for m in milestones if m < min_milestone or m > max_milestone]
    if out_of_range:
        return Response(
            {
                "challenge_milestones": (
                    f"All milestone options must be between {min_milestone:,} and {max_milestone:,} steps"
                )
            },
            status=status.HTTP_400_BAD_REQUEST,
        )

    # Money limits must still make sense together once merged with what is stored
    # (blank = the server value).
    from apps.admin_api.business_rules import server_value

    def _merged(key):
        if key in serializer.validated_data:
            v = serializer.validated_data[key]
        else:
            v = getattr(settings, key, None)
        return v if v is not None else server_value(key)

    lo_dep, hi_dep = _merged("min_deposit_kes"), _merged("max_deposit_kes")
    if lo_dep is not None and hi_dep is not None and Decimal(str(lo_dep)) > Decimal(str(hi_dep)):
        return Response(
            {"max_deposit_kes": "Must be at least the smallest deposit"},
            status=status.HTTP_400_BAD_REQUEST,
        )
    min_wd = serializer.validated_data.get("minimum_withdrawal_amount", settings.minimum_withdrawal_amount)
    max_wd = _merged("max_withdrawal_kes")
    if max_wd is not None and Decimal(str(min_wd)) > Decimal(str(max_wd)):
        return Response(
            {"max_withdrawal_kes": "Must be at least the minimum withdrawal"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    # Capture changes for audit log
    changes = {}
    for key, value in serializer.validated_data.items():
        old_value = getattr(settings, key, None)
        if old_value != value:
            changes[key] = {
                "old": str(old_value) if old_value is not None else None,
                "new": str(value) if value is not None else None,
            }

    # Update settings
    for key, value in serializer.validated_data.items():
        setattr(settings, key, value)

    settings.updated_by = request.user
    settings.save()

    # Log the action
    AuditLog.log_action(
        admin=request.user,
        action="settings_change",
        resource_type="settings",
        description=f"Updated system settings: {', '.join(changes.keys())}",
        changes=changes,
        request=request,
    )

    return Response(SystemSettingsSerializer(settings).data)


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff())
def get_audit_logs(request):
    """Get audit logs with filtering"""
    from apps.admin_api.models import AuditLog
    from apps.admin_api.serializers import AuditLogSerializer

    logs = AuditLog.objects.all()

    # Apply filters
    action = request.query_params.get("action")
    if action:
        logs = logs.filter(action=action)

    resource_type = request.query_params.get("resource_type")
    if resource_type:
        logs = logs.filter(resource_type=resource_type)

    admin_username = request.query_params.get("admin_username")
    if admin_username:
        logs = logs.filter(admin_username__icontains=admin_username)

    if request.query_params.get("exclude_auth") == "true":
        logs = logs.exclude(action__in=["login", "logout"])

    resource_id = request.query_params.get("resource_id")
    if resource_id and resource_id.isdigit():
        logs = logs.filter(resource_id=int(resource_id))

    search = (request.query_params.get("search") or "").strip()
    if search:
        logs = logs.filter(
            Q(description__icontains=search)
            | Q(resource_name__icontains=search)
            | Q(admin_username__icontains=search)
        )

    # Date filtering
    from_date = request.query_params.get("from_date")
    if from_date:
        logs = logs.filter(created_at__gte=from_date)

    to_date = request.query_params.get("to_date")
    if to_date:
        logs = logs.filter(created_at__lte=to_date)

    # Pagination
    try:
        limit = max(1, min(1000, int(request.query_params.get("limit", 100))))
        offset = max(0, int(request.query_params.get("offset", 0)))
    except ValueError:
        return Response(
            {"error": "Invalid pagination parameters"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    total = logs.count()
    logs = logs[offset : offset + limit]

    serializer = AuditLogSerializer(logs, many=True)

    return Response(
        {
            "total": total,
            "results": serializer.data,
            "admins": list(
                AuditLog.objects.order_by()
                .values_list("admin_username", flat=True)
                .distinct()[:100]
            ),
        }
    )


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff())
def get_steps_logs(request):
    """Get historical step logs for all users with pagination and filters."""

    logs = HealthRecord.objects.select_related("user").all()

    search = request.query_params.get("search", "").strip()
    if search:
        logs = logs.filter(
            Q(user__username__icontains=search) | Q(user__email__icontains=search)
        )

    from_date = request.query_params.get("from_date")
    if from_date:
        logs = logs.filter(date__gte=from_date)

    to_date = request.query_params.get("to_date")
    if to_date:
        logs = logs.filter(date__lte=to_date)

    suspicious = request.query_params.get("suspicious")
    if suspicious in {"true", "false"}:
        logs = logs.filter(is_suspicious=(suspicious == "true"))

    user_id = request.query_params.get("user_id")
    if user_id and user_id.isdigit():
        logs = logs.filter(user_id=int(user_id))

    source = request.query_params.get("source")
    if source in {choice for choice, _ in HealthRecord.SOURCE_CHOICES}:
        logs = logs.filter(source=source)

    min_steps = request.query_params.get("min_steps")
    if min_steps and min_steps.isdigit():
        logs = logs.filter(steps__gte=int(min_steps))

    filtered_logs = logs
    order = request.query_params.get("order", "asc").lower()
    sort = request.query_params.get("sort", "date")
    if sort == "steps":
        logs = logs.order_by(
            "-steps" if order == "desc" else "steps", "-date", "-id"
        )
    elif order == "desc":
        logs = logs.order_by("-date", "-synced_at", "-id")
    else:
        logs = logs.order_by("date", "synced_at", "id")

    try:
        limit = max(1, min(500, int(request.query_params.get("limit", 100))))
        offset = max(0, int(request.query_params.get("offset", 0)))
    except ValueError:
        return Response(
            {"error": "Invalid pagination parameters"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    total = logs.count()
    aggregate = logs.aggregate(
        total_steps=Sum("steps"),
        users_with_logs=Count("user_id", distinct=True),
        first_log_at=Min("date"),
        last_log_at=Max("date"),
    )

    paged_logs = list(logs[offset : offset + limit])
    reasons = step_flag_reasons(paged_logs)
    results = []
    for row in paged_logs:
        results.append(
            {
                "id": row.id,
                "user_id": row.user_id,
                "username": row.user.username,
                "email": row.user.email,
                "date": row.date,
                "synced_at": row.synced_at,
                "source": row.source,
                "steps": row.steps,
                "distance_km": row.distance_km,
                "calories_active": row.calories_active,
                "active_minutes": row.active_minutes,
                "is_suspicious": row.is_suspicious,
                "reasons": reasons.get((row.user_id, row.date), []),
            }
        )

    return Response(
        {
            "total": total,
            "results": results,
            "summary": {
                "total_steps": int(aggregate.get("total_steps") or 0),
                "users_with_logs": int(aggregate.get("users_with_logs") or 0),
                "first_log_at": aggregate.get("first_log_at"),
                "last_log_at": aggregate.get("last_log_at"),
                "suspicious_count": filtered_logs.filter(is_suspicious=True).count(),
                "distribution": step_distribution(filtered_logs),
                "daily": step_daily_totals(filtered_logs),
            },
        }
    )


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff())
def get_steps_hourly_breakdown(request):
    """Get server-side hourly steps breakdown for a user/day."""

    user_id = request.query_params.get("user_id")
    if not user_id:
        return Response(
            {"error": "user_id is required"}, status=status.HTTP_400_BAD_REQUEST
        )

    try:
        user_id_int = int(user_id)
    except (TypeError, ValueError):
        return Response(
            {"error": "user_id must be an integer"}, status=status.HTTP_400_BAD_REQUEST
        )

    date = request.query_params.get("date")
    if date:
        target_date = date
    else:
        latest = (
            HourlyStepRecord.objects.filter(user_id=user_id_int)
            .order_by("-date")
            .first()
        )
        if not latest:
            return Response(
                {
                    "user_id": user_id_int,
                    "date": None,
                    "hours": [],
                    "summary": {
                        "total_steps": 0,
                        "total_distance_km": 0.0,
                        "total_calories": 0.0,
                    },
                }
            )
        target_date = latest.date

    hourly_qs = (
        HourlyStepRecord.objects.filter(user_id=user_id_int, date=target_date)
        .values("hour")
        .annotate(
            steps=Sum("steps"),
            distance_km=Sum("distance_km"),
            calories=Sum("calories"),
        )
        .order_by("hour")
    )

    by_hour = {
        int(item["hour"]): {
            "steps": int(item["steps"] or 0),
            "distance_km": float(item["distance_km"] or 0.0),
            "calories": float(item["calories"] or 0.0),
        }
        for item in hourly_qs
    }

    hours = []
    total_steps = 0
    total_distance = 0.0
    total_calories = 0.0
    for hour in range(24):
        data = by_hour.get(hour, {"steps": 0, "distance_km": 0.0, "calories": 0.0})
        total_steps += data["steps"]
        total_distance += data["distance_km"]
        total_calories += data["calories"]
        hours.append(
            {
                "hour": hour,
                "label": f"{hour:02d}:00",
                "steps": data["steps"],
                "distance_km": round(data["distance_km"], 3),
                "calories": round(data["calories"], 2),
            }
        )

    return Response(
        {
            "user_id": user_id_int,
            "date": target_date,
            "hours": hours,
            "summary": {
                "total_steps": total_steps,
                "total_distance_km": round(total_distance, 3),
                "total_calories": round(total_calories, 2),
            },
        }
    )


@extend_schema(
    operation_id="admin_support_tickets_list",
    responses={200: OpenApiTypes.OBJECT, 400: OpenApiTypes.OBJECT},
)
@api_view(["GET"])
@permission_classes(staff("support.view"))
def get_support_tickets(request):
    """Get support tickets with filtering and pagination"""
    from apps.admin_api.models import SupportTicket

    tickets = SupportTicket.objects.select_related("user", "assigned_to").all()

    status_filter = request.query_params.get("status")
    if status_filter:
        tickets = tickets.filter(status=status_filter)

    priority_filter = request.query_params.get("priority")
    if priority_filter:
        tickets = tickets.filter(priority=priority_filter)

    assigned_to = request.query_params.get("assigned_to")
    if assigned_to:
        if assigned_to == "unassigned":
            tickets = tickets.filter(assigned_to__isnull=True)
        else:
            tickets = tickets.filter(assigned_to_id=assigned_to)

    query = request.query_params.get("q", "").strip()
    if query:
        from django.db.models import Q

        tickets = tickets.filter(
            Q(subject__icontains=query)
            | Q(message__icontains=query)
            | Q(user__username__icontains=query)
            | Q(user__email__icontains=query)
        )

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
    serializer = SupportTicketSerializer(paged, many=True)

    return Response(
        {
            "total": total,
            "results": serializer.data,
        }
    )


@extend_schema(
    operation_id="admin_support_ticket_detail",
    responses={200: OpenApiTypes.OBJECT, 404: OpenApiTypes.OBJECT},
)
@api_view(["GET"])
@permission_classes(staff("support.view"))
def get_support_ticket_detail(request, ticket_id):
    """Get a support ticket and its conversation thread"""
    from apps.admin_api.models import SupportTicket

    try:
        ticket = SupportTicket.objects.select_related("user", "assigned_to").get(
            id=ticket_id
        )
    except SupportTicket.DoesNotExist:
        return Response(
            {"error": "Support ticket not found"}, status=status.HTTP_404_NOT_FOUND
        )

    messages = ticket.messages.select_related("sender").all()

    return Response(
        {
            "ticket": SupportTicketSerializer(ticket).data,
            "messages": SupportTicketMessageSerializer(messages, many=True).data,
        }
    )


@extend_schema(
    request=OpenApiTypes.OBJECT,
    responses={
        200: OpenApiTypes.OBJECT,
        400: OpenApiTypes.OBJECT,
        404: OpenApiTypes.OBJECT,
    },
)
@api_view(["POST"])
@permission_classes(staff("support.reply"))
def reply_support_ticket(request, ticket_id):
    """Post an admin reply to a support ticket"""
    from apps.admin_api.models import (AuditLog, SupportTicket,
                                       SupportTicketMessage)
    from apps.admin_api.realtime import (broadcast_support_message,
                                         broadcast_support_ticket)

    try:
        ticket = SupportTicket.objects.get(id=ticket_id)
    except SupportTicket.DoesNotExist:
        return Response(
            {"error": "Support ticket not found"}, status=status.HTTP_404_NOT_FOUND
        )

    message_text = request.data.get("message", "").strip()
    if not message_text:
        return Response(
            {"error": "message is required"}, status=status.HTTP_400_BAD_REQUEST
        )

    reply = SupportTicketMessage.objects.create(
        ticket=ticket,
        sender=request.user,
        sender_username=request.user.username,
        is_admin=True,
        message=message_text,
    )

    changed_fields = []
    if ticket.status == "open":
        ticket.status = "in_progress"
        changed_fields.append("status")

    if ticket.assigned_to_id is None:
        ticket.assigned_to = request.user
        changed_fields.append("assigned_to")

    if changed_fields:
        ticket.save(update_fields=changed_fields + ["updated_at"])

    ticket.refresh_from_db()

    AuditLog.log_action(
        admin=request.user,
        action="update",
        resource_type="support",
        resource_id=ticket.id,
        resource_name=ticket.subject,
        description=f"Replied to support ticket #{ticket.id}",
        request=request,
    )

    broadcast_support_message(
        ticket.id,
        {
            "id": reply.id,
            "ticket": ticket.id,
            "sender": request.user.id,
            "sender_username": request.user.username,
            "is_admin": True,
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
            "assigned_to": ticket.assigned_to_id,
            "updated_at": ticket.updated_at.isoformat(),
        },
    )

    return Response(
        {
            "message": "Reply sent successfully",
            "reply": SupportTicketMessageSerializer(reply).data,
        }
    )


@extend_schema(
    request=OpenApiTypes.OBJECT,
    responses={
        200: OpenApiTypes.OBJECT,
        400: OpenApiTypes.OBJECT,
        404: OpenApiTypes.OBJECT,
    },
)
@api_view(["POST"])
@permission_classes(staff("support.reply"))
def update_support_ticket(request, ticket_id):
    """Update support ticket status, priority, assignment, and admin notes"""
    from apps.admin_api.models import AuditLog, SupportTicket
    from apps.admin_api.realtime import broadcast_support_ticket

    try:
        ticket = SupportTicket.objects.get(id=ticket_id)
    except SupportTicket.DoesNotExist:
        return Response(
            {"error": "Support ticket not found"}, status=status.HTTP_404_NOT_FOUND
        )

    updates = {}

    if "status" in request.data:
        new_status = request.data.get("status")
        valid_statuses = {choice[0] for choice in SupportTicket.STATUS_CHOICES}
        if new_status not in valid_statuses:
            return Response(
                {"error": "Invalid status"}, status=status.HTTP_400_BAD_REQUEST
            )
        updates["status"] = new_status

    if "priority" in request.data:
        new_priority = request.data.get("priority")
        valid_priorities = {choice[0] for choice in SupportTicket.PRIORITY_CHOICES}
        if new_priority not in valid_priorities:
            return Response(
                {"error": "Invalid priority"}, status=status.HTTP_400_BAD_REQUEST
            )
        updates["priority"] = new_priority

    if "assigned_to" in request.data:
        assigned_to = request.data.get("assigned_to")
        if assigned_to in [None, "", "null"]:
            updates["assigned_to"] = None
        else:
            try:
                admin_user = User.objects.get(id=int(assigned_to), is_staff=True)
            except (ValueError, User.DoesNotExist):
                return Response(
                    {"error": "Invalid admin assignee"},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            updates["assigned_to"] = admin_user

    if "admin_notes" in request.data:
        updates["admin_notes"] = str(request.data.get("admin_notes") or "").strip()

    if not updates:
        return Response(
            {"error": "No valid fields to update"}, status=status.HTTP_400_BAD_REQUEST
        )

    previous = {
        "status": ticket.status,
        "priority": ticket.priority,
        "assigned_to": ticket.assigned_to.username if ticket.assigned_to else None,
        "admin_notes": ticket.admin_notes,
    }

    for field, value in updates.items():
        setattr(ticket, field, value)

    if updates.get("status") in ["resolved", "closed"]:
        ticket.resolved_at = timezone.now()
    elif updates.get("status") in ["open", "in_progress"]:
        ticket.resolved_at = None

    ticket.save()

    current = {
        "status": ticket.status,
        "priority": ticket.priority,
        "assigned_to": ticket.assigned_to.username if ticket.assigned_to else None,
        "admin_notes": ticket.admin_notes,
    }

    changed = {}
    for key in current:
        if previous[key] != current[key]:
            changed[key] = {"old": previous[key], "new": current[key]}

    AuditLog.log_action(
        admin=request.user,
        action="update",
        resource_type="support",
        resource_id=ticket.id,
        resource_name=ticket.subject,
        description=f"Updated support ticket #{ticket.id}",
        changes=changed,
        request=request,
    )

    broadcast_support_ticket(
        ticket.id,
        {
            "id": ticket.id,
            "status": ticket.status,
            "priority": ticket.priority,
            "assigned_to": ticket.assigned_to_id,
            "admin_notes": ticket.admin_notes,
            "updated_at": ticket.updated_at.isoformat(),
        },
    )

    return Response(
        {
            "message": "Ticket updated successfully",
            "ticket": SupportTicketSerializer(ticket).data,
        }
    )


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff("support.view"))
def get_support_admins(request):
    """Get staff users eligible for support ticket assignment"""
    admins = (
        User.objects.filter(is_staff=True, is_active=True)
        .order_by("username")
        .values("id", "username", "email")
    )
    return Response({"results": list(admins)})


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff("trust.view"))
def fraud_overview(request):
    from apps.steps.models import FraudFlag, TrustScore

    today = timezone.now().date()
    open_flags = FraudFlag.objects.filter(reviewed=False).select_related("user")
    reviewed_flags = (
        FraudFlag.objects.filter(reviewed=True, actioned=True)
        .select_related("user", "user__trust_score")
        .order_by("-created_at")[:50]
    )

    recent_flags_payload = []
    for flag in open_flags.order_by("-created_at")[:50]:
        recent_flags_payload.append(
            {
                "id": flag.id,
                "user_username": flag.user.username,
                "user_email": flag.user.email,
                "flag_type": flag.flag_type,
                "severity": flag.severity,
                "date": flag.date,
                "details": flag.details,
                "reviewed": flag.reviewed,
                "actioned": flag.actioned,
                "created_at": flag.created_at,
            }
        )

    reviewed_flags_payload = []
    for flag in reviewed_flags:
        trust = getattr(flag.user, "trust_score", None)
        details = flag.details if isinstance(flag.details, dict) else {}
        reviewed_flags_payload.append(
            {
                "id": flag.id,
                "user_username": flag.user.username,
                "user_email": flag.user.email,
                "flag_type": flag.flag_type,
                "severity": flag.severity,
                "date": flag.date,
                "details": details,
                "reviewed": flag.reviewed,
                "actioned": flag.actioned,
                "created_at": flag.created_at,
                "last_action": details.get("admin_action"),
                "current_trust_score": trust.score if trust else 100,
                "current_trust_status": trust.status if trust else "GOOD",
            }
        )

    return Response(
        {
            "open_flags": FraudFlag.objects.filter(reviewed=False).count(),
            "critical_unread": FraudFlag.objects.filter(
                reviewed=False, severity="critical"
            ).count(),
            "high_unread": FraudFlag.objects.filter(
                reviewed=False, severity="high"
            ).count(),
            "restricted_users": TrustScore.objects.filter(
                score__lte=40, score__gt=20
            ).count(),
            "suspended_users": TrustScore.objects.filter(
                score__lte=20, score__gt=0
            ).count(),
            "banned_users": TrustScore.objects.filter(score=0).count(),
            "flags_today": FraudFlag.objects.filter(created_at__date=today).count(),
            "recent_flags": recent_flags_payload,
            "reviewed_flags": reviewed_flags_payload,
        }
    )


# ── Payment Management (PochPay) ──────────────────────────────────────────────


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff("finance.view"))
def payments_overview(request):
    """Admin dashboard financial overview."""
    from datetime import timedelta

    from apps.payments import intasend
    from apps.payments.models import PaymentTransaction

    today = timezone.now().date()
    last_7_days = today - timedelta(days=7)

    completed_deposits = PaymentTransaction.objects.filter(
        type="deposit", status="completed", created_at__date__gte=last_7_days
    )
    completed_payouts = PaymentTransaction.objects.filter(
        type="payout", status="completed", created_at__date__gte=last_7_days
    )
    pending_txns = PaymentTransaction.objects.filter(status="pending")

    # Get live platform balance from IntaSend
    try:
        platform_balance = intasend.get_platform_balance()
    except Exception:
        platform_balance = {"balance": "Error fetching", "currency": "KES"}

    return Response(
        {
            "platform_balance": platform_balance,
            "deposits_7d_total": completed_deposits.aggregate(t=Sum("amount_kes"))["t"]
            or 0,
            "deposits_7d_count": completed_deposits.count(),
            "payouts_7d_total": completed_payouts.aggregate(t=Sum("amount_kes"))["t"]
            or 0,
            "payouts_7d_count": completed_payouts.count(),
            "pending_count": pending_txns.count(),
            "pending_total": pending_txns.aggregate(t=Sum("amount_kes"))["t"] or 0,
            "failed_today": PaymentTransaction.objects.filter(
                status="failed", created_at__date=today
            ).count(),
        }
    )


@extend_schema(
    request=None, responses={200: OpenApiTypes.OBJECT, 400: OpenApiTypes.OBJECT}
)
@api_view(["POST"])
@permission_classes(staff("finance.withdrawals"))
def retry_payout(request, txn_id):
    """Admin checks current IntaSend status of a failed/pending payout."""
    from apps.payments import intasend
    from apps.payments.models import PaymentTransaction

    txn = get_object_or_404(PaymentTransaction, id=txn_id, type="payout")

    lock_key = f"admin:retry_payout:{txn_id}"
    if not acquire_lock(lock_key, ttl_seconds=20):
        return Response(
            {"error": "Another retry check is in progress for this payout."}, status=429
        )

    try:
        if txn.status == "completed":
            return Response({"error": "Transaction already completed"}, status=400)

        if not txn.tracking_reference:
            return Response(
                {"error": "No tracking reference available — cannot check status"},
                status=400,
            )

        try:
            status_data = intasend.get_disbursement_status(txn.tracking_reference)
            return Response({"status": "Status retrieved", "result": status_data})
        except Exception as e:
            logger.error(f"Retry payout status check failed | txn={txn_id}: {e}")
            return Response(
                {"error": "Failed to retrieve disbursement status from IntaSend."},
                status=502,
            )
    finally:
        release_lock(lock_key)


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff("finance.view"))
def withdrawal_queue(request):
    """
    Returns all pending withdrawals for admin review.
    Sorted oldest-first so admins process in order.
    """
    status_filter = request.query_params.get("status", "pending_review")

    withdrawals = (
        WithdrawalRequest.objects.filter(status=status_filter)
        .select_related("user")
        .order_by("created_at")
    )

    return Response(
        [
            {
                "id": str(w.id),
                "user_id": w.user.id,
                "username": w.user.username,
                "email": w.user.email,
                "phone": w.user.phone_number,
                "amount_kes": str(w.amount_kes),
                "method": w.method,
                "destination": w.destination_display,
                "status": w.status,
                "created_at": w.created_at.isoformat(),
                "age_hours": round(
                    (timezone.now() - w.created_at).total_seconds() / 3600, 1
                ),
            }
            for w in withdrawals
        ]
    )


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff("finance.view"))
def withdrawal_stats(request):
    """Stats for the admin withdrawal dashboard."""
    from django.db.models import Sum

    today = timezone.now().date()

    return Response(
        {
            "pending_count": WithdrawalRequest.objects.filter(
                status="pending_review"
            ).count(),
            "pending_total_kes": str(
                WithdrawalRequest.objects.filter(status="pending_review").aggregate(
                    t=Sum("amount_kes")
                )["t"]
                or 0
            ),
            "approved_today": WithdrawalRequest.objects.filter(
                status__in=["approved", "processing", "completed"],
                reviewed_at__date=today,
            ).count(),
            "completed_today": WithdrawalRequest.objects.filter(
                status="completed",
                callback_received_at__date=today,
            ).count(),
            "failed_today": WithdrawalRequest.objects.filter(
                status="failed",
                updated_at__date=today,
            ).count(),
            "total_paid_today": str(
                WithdrawalRequest.objects.filter(
                    status="completed",
                    callback_received_at__date=today,
                ).aggregate(t=Sum("amount_kes"))["t"]
                or 0
            ),
        }
    )


@extend_schema(
    request=None,
    responses={
        200: OpenApiTypes.OBJECT,
        400: OpenApiTypes.OBJECT,
        502: OpenApiTypes.OBJECT,
    },
)
@api_view(["POST"])
@permission_classes(staff("finance.withdrawals"))
def approve_withdrawal(request, withdrawal_id):
    """
    Admin approves a withdrawal. This immediately sends it to IntaSend.
    IntaSend generates a tracking_id which is stored in the withdrawal record.
    """
    lock_key = f"admin:approve_withdrawal:{withdrawal_id}"
    if not acquire_lock(lock_key, ttl_seconds=45):
        return Response(
            {"error": "Another admin is already processing this withdrawal."},
            status=429,
        )

    try:
        withdrawal = get_object_or_404(WithdrawalRequest, id=withdrawal_id)
        withdrawal, tracking_id = approve_withdrawal_and_send(
            withdrawal, reviewer=request.user
        )

        _notify_user(
            withdrawal.user,
            "withdrawal_approved",
            admin=request.user,
            amount=withdrawal.amount_kes,
            method=withdrawal.method,
        )

        from apps.admin_api.models import AuditLog

        AuditLog.log_action(
            admin=request.user, action="approve", resource_type="withdrawal",  # UUID id: kept in changes (resource_id is an integer)
            resource_name=withdrawal.user.username,
            description=f"Approved withdrawal of KES {withdrawal.amount_kes} ({withdrawal.method})",
            changes={"withdrawal_id": str(withdrawal.id), "amount_kes": str(withdrawal.amount_kes), "tracking_id": tracking_id}, request=request,
        )
        logger.info(
            f"Withdrawal approved and sent | id={withdrawal_id} | "
            f"admin={request.user.username} | KES {withdrawal.amount_kes} | "
            f"tracking_id={tracking_id}"
        )
        return Response(
            {
                "message": "Withdrawal approved and sent to IntaSend.",
                "tracking_id": tracking_id,
                "status": "processing",
            }
        )

    except PaymentsServiceError as exc:
        return Response({"error": exc.message}, status=exc.status_code)
    except Exception as e:
        logger.error(f"IntaSend call failed after approval | id={withdrawal_id}: {e}")

        return Response(
            {"error": "Disbursement failed. Balance refunded to user."}, status=502
        )
    finally:
        release_lock(lock_key)


@extend_schema(
    request=OpenApiTypes.OBJECT,
    responses={200: OpenApiTypes.OBJECT, 400: OpenApiTypes.OBJECT},
)
@api_view(["POST"])
@permission_classes(staff("finance.withdrawals"))
def reject_withdrawal(request, withdrawal_id):
    """
    Admin rejects a withdrawal request.
    Balance is immediately refunded to the user.
    """
    reason = request.data.get("reason", "Rejected by admin")

    try:
        withdrawal = get_object_or_404(WithdrawalRequest, id=withdrawal_id)
        withdrawal = reject_withdrawal_request(
            withdrawal, reason=reason, reviewer=request.user
        )
    except PaymentsServiceError as exc:
        return Response({"error": exc.message}, status=exc.status_code)

    _notify_user(
        withdrawal.user,
        "withdrawal_rejected",
        admin=request.user,
        amount=withdrawal.amount_kes,
        reason=reason,
    )

    from apps.admin_api.models import AuditLog

    AuditLog.log_action(
        admin=request.user, action="reject", resource_type="withdrawal",  # UUID id: kept in changes (resource_id is an integer)
        resource_name=withdrawal.user.username,
        description=f"Rejected withdrawal of KES {withdrawal.amount_kes} (refunded)",
        changes={"withdrawal_id": str(withdrawal.id), "amount_kes": str(withdrawal.amount_kes), "reason": str(reason)[:500]}, request=request,
    )
    logger.info(
        f"Withdrawal rejected | id={withdrawal_id} | "
        f"admin={request.user.username} | reason={reason}"
    )
    return Response(
        {"message": f"Withdrawal rejected. KES {withdrawal.amount_kes} refunded."}
    )


@extend_schema(
    request=None,
    responses={
        200: OpenApiTypes.OBJECT,
        400: OpenApiTypes.OBJECT,
        502: OpenApiTypes.OBJECT,
    },
)
@api_view(["POST"])
@permission_classes(staff("finance.withdrawals"))
def retry_failed_withdrawal(request, withdrawal_id):
    """
    Admin checks current IntaSend status of a failed withdrawal.
    Returns the current status from IntaSend.
    To re-send a failed withdrawal, use approve_withdrawal on a new request.
    """
    lock_key = f"admin:retry_withdrawal:{withdrawal_id}"
    if not acquire_lock(lock_key, ttl_seconds=20):
        return Response(
            {"error": "Another retry check is in progress for this withdrawal."},
            status=429,
        )

    withdrawal = get_object_or_404(WithdrawalRequest, id=withdrawal_id)

    try:
        if not withdrawal.tracking_reference:
            return Response(
                {"error": "No tracking reference — cannot check status"}, status=400
            )

        try:
            status_data = intasend.get_disbursement_status(
                withdrawal.tracking_reference
            )
            return Response({"message": "Status retrieved", "result": status_data})

        except Exception as e:
            logger.error(f"Withdrawal status check failed | id={withdrawal_id}: {e}")
            return Response(
                {"error": "Failed to retrieve withdrawal status from IntaSend."},
                status=502,
            )
    finally:
        release_lock(lock_key)


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff())
def ops_monitoring_dashboard(request):
    """
    Aggregated operational monitoring metrics for admin dashboards.
    Includes fraud load, withdrawal queue age, callback failures, and duplicate-request rejections.
    """
    from apps.admin_api.business_rules import (drift_thresholds,
                                               reconciliation_thresholds)

    financial = run_financial_reconciliation(thresholds=reconciliation_thresholds(), send_alerts=False)
    drift = run_anticheat_shadow_drift_monitor(
        thresholds=drift_thresholds(),
        send_alerts=False,
    )

    merged = {
        **financial,
        "anti_cheat_drift": drift,
    }
    if not drift["ok"]:
        merged["breaches"] = merged.get("breaches", []) + [
            f"anticheat_drift:{breach}" for breach in drift.get("breaches", [])
        ]
    merged["ok"] = bool(financial.get("ok")) and bool(drift.get("ok"))
    return Response(merged)
