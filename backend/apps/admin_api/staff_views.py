"""Staff & roles (owner only) and the signed-in staff member's permissions.

GET  /api/admin/me/permissions/            any staff: roles + permissions (console hides the rest)
GET  /api/admin/staff/                     owner: staff accounts, their roles, invites, role catalogue
POST /api/admin/staff/invite/              owner: promote an existing user or create a one-time invite code
POST /api/admin/staff/<id>/roles/          owner: change roles (owner role = superuser)
POST /api/admin/staff/<id>/remove/         owner: remove staff access (and sign them out everywhere)
POST /api/admin/staff/invites/<id>/revoke/ owner: revoke a pending invite
GET/PATCH /api/admin/finance/controls/     finance.view reads; owner changes the two-person threshold

New staff accounts register with an invite code (apps/admin_api/views.admin_register);
ADMIN_REGISTRATION_CODE only bootstraps the very first (owner) account.
"""

from datetime import timedelta
from decimal import Decimal, InvalidOperation

from django.contrib.auth import get_user_model
from django.db import transaction as db_transaction
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from drf_spectacular.utils import OpenApiTypes, extend_schema
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.admin_api.models import AuditLog, ConsoleControls, StaffInvite, StaffProfile
from apps.admin_api.roles import (OWNER, ROLE_LABELS, catalog, clean_roles, is_owner,
                                  permissions_payload, roles_for, staff)

User = get_user_model()

INVITE_DAYS = 7
REASON_MAX = 500


def _audit(request, action, description, *, user=None, changes=None):
    AuditLog.log_action(
        admin=request.user,
        action=action,
        resource_type="staff",
        resource_id=user.id if user is not None else None,
        resource_name=user.username if user is not None else "",
        description=description,
        changes=changes,
        request=request,
    )


def _staff_row(u):
    profile = getattr(u, "staff_profile", None) if hasattr(u, "staff_profile") else None
    return {
        "id": u.id,
        "username": u.username,
        "email": u.email,
        "is_active": u.is_active,
        "is_owner": bool(u.is_superuser),
        "roles": roles_for(u),
        "legacy_roles": bool(not u.is_superuser and profile is None),
        "last_login": u.last_login.isoformat() if u.last_login else None,
        "date_joined": u.date_joined.isoformat() if u.date_joined else None,
        "roles_updated_at": profile.updated_at.isoformat() if profile else None,
    }


def _invite_row(i: StaffInvite):
    return {
        "id": i.id,
        "email": i.email,
        "roles": clean_roles(i.roles),
        "status": i.status,
        "code_hint": i.code_hint,
        "created_by": i.created_by.username if i.created_by_id else None,
        "created_at": i.created_at.isoformat(),
        "expires_at": i.expires_at.isoformat(),
        "accepted_at": i.accepted_at.isoformat() if i.accepted_at else None,
        "accepted_username": i.accepted_user.username if i.accepted_user_id else None,
    }


def _set_roles(user, roles, admin):
    """Write roles for a staff account. The owner role means superuser."""
    owner = OWNER in roles
    others = [r for r in roles if r != OWNER]
    user.is_staff = True
    user.is_superuser = owner
    user.save(update_fields=["is_staff", "is_superuser"])
    StaffProfile.objects.update_or_create(user=user, defaults={"roles": others, "updated_by": admin})


def _reason(request):
    return str(request.data.get("reason") or "").strip()[:REASON_MAX]


def _active_owner_count(exclude_id=None):
    qs = User.objects.filter(is_superuser=True, is_staff=True, is_active=True)
    if exclude_id:
        qs = qs.exclude(id=exclude_id)
    return qs.count()


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff())
def my_permissions(request):
    return Response(permissions_payload(request.user))


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(staff("owner.staff"))
def staff_list(request):
    users = User.objects.filter(is_staff=True).select_related("staff_profile").order_by("-is_superuser", "username")
    invites = StaffInvite.objects.select_related("created_by", "accepted_user")[:50]
    return Response(
        {
            "staff": [_staff_row(u) for u in users],
            "invites": [_invite_row(i) for i in invites],
            "catalog": catalog(),
        }
    )


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT, 201: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(staff("owner.staff"))
def staff_invite(request):
    """Invite staff by email or username.

    An existing account is promoted immediately with the chosen roles (it keeps its own
    password). Otherwise a one-time invite code is created for the email: the person
    registers on the console's sign-up page with it (valid for 7 days). The code is
    shown once."""
    identifier = str(request.data.get("identifier") or request.data.get("email") or "").strip()
    roles = clean_roles(request.data.get("roles"))
    reason = _reason(request)
    if not identifier:
        return Response({"error": "Enter the person's email or username."}, status=400)
    if not roles:
        return Response({"error": "Choose at least one role."}, status=400)

    existing = User.objects.filter(Q(email__iexact=identifier) | Q(username__iexact=identifier)).first()
    if existing is not None:
        if existing.deleted_at if hasattr(existing, "deleted_at") else False:
            return Response({"error": "That account was deleted."}, status=409)
        if not existing.is_active:
            return Response({"error": "That account is banned. Unban it first."}, status=409)
        if existing.is_staff:
            return Response({"error": "That account already has staff access. Change its roles instead."}, status=409)
        with db_transaction.atomic():
            _set_roles(existing, roles, request.user)
        _audit(
            request, "promote", f"Granted staff access to {existing.username}",
            user=existing, changes={"roles": roles, "is_staff": {"old": False, "new": True}, "reason": reason},
        )
        return Response({"status": "promoted", "staff": _staff_row(existing)})

    if "@" not in identifier:
        return Response({"error": "No account has that username. To invite someone new, enter their email."}, status=404)
    code = StaffInvite.new_code()
    with db_transaction.atomic():
        # One live invite per email: older pending ones are revoked.
        StaffInvite.objects.filter(
            email__iexact=identifier, accepted_at__isnull=True, revoked_at__isnull=True
        ).update(revoked_at=timezone.now())
        invite = StaffInvite.objects.create(
            email=identifier.lower(),
            roles=roles,
            code_hash=StaffInvite.hash_code(code),
            code_hint=code[-4:],
            created_by=request.user,
            expires_at=timezone.now() + timedelta(days=INVITE_DAYS),
        )
    _audit(
        request, "invite", f"Invited {invite.email} as staff",
        changes={"invite_id": invite.id, "email": invite.email, "roles": roles, "reason": reason},
    )
    return Response({"status": "invited", "invite": _invite_row(invite), "code": code}, status=201)


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(staff("owner.staff"))
def staff_set_roles(request, user_id):
    user = get_object_or_404(User, id=user_id, is_staff=True)
    roles = clean_roles(request.data.get("roles"))
    if not roles:
        return Response({"error": "Choose at least one role, or remove staff access instead."}, status=400)
    before = roles_for(user)
    if user.is_superuser and OWNER not in roles:
        if user.id == request.user.id:
            return Response({"error": "You cannot remove your own owner role."}, status=400)
        if _active_owner_count(exclude_id=user.id) == 0:
            return Response({"error": "At least one owner must remain."}, status=400)
    with db_transaction.atomic():
        _set_roles(user, roles, request.user)
    user.refresh_from_db()
    _audit(
        request, "roles_change", f"Changed roles for {user.username}",
        user=user, changes={"roles": {"old": before, "new": roles_for(user)}, "reason": _reason(request)},
    )
    return Response({"status": "ok", "staff": _staff_row(user)})


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(staff("owner.staff"))
def staff_remove(request, user_id):
    user = get_object_or_404(User, id=user_id, is_staff=True)
    if user.id == request.user.id:
        return Response({"error": "You cannot remove your own staff access."}, status=400)
    if user.is_superuser and _active_owner_count(exclude_id=user.id) == 0:
        return Response({"error": "At least one owner must remain."}, status=400)
    before = roles_for(user)
    from apps.users.account_deletion import _revoke_all_tokens

    with db_transaction.atomic():
        user.is_staff = False
        user.is_superuser = False
        user.save(update_fields=["is_staff", "is_superuser"])
        StaffProfile.objects.filter(user=user).delete()
        revoked = _revoke_all_tokens(user)
    _audit(
        request, "demote", f"Removed staff access from {user.username}",
        user=user,
        changes={"is_staff": {"old": True, "new": False}, "roles": {"old": before, "new": []},
                 "sessions_revoked": revoked, "reason": _reason(request)},
    )
    return Response({"status": "removed", "user_id": user.id})


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(staff("owner.staff"))
def staff_invite_revoke(request, invite_id):
    invite = get_object_or_404(StaffInvite, id=invite_id)
    if invite.status != "pending":
        return Response({"error": f"This invite is already {invite.status}."}, status=409)
    invite.revoked_at = timezone.now()
    invite.save(update_fields=["revoked_at"])
    _audit(request, "revoke", f"Revoked the staff invite for {invite.email}", changes={"invite_id": invite.id})
    return Response({"status": "revoked", "invite": _invite_row(invite)})


def accept_invite(code: str, email: str):
    """The pending invite matching this code and email, or None (register flow)."""
    if not code:
        return None
    invite = StaffInvite.objects.filter(code_hash=StaffInvite.hash_code(code)).first()
    if invite is None or invite.status != "pending" or invite.email.lower() != (email or "").strip().lower():
        return None
    return invite


def _controls_payload(c: ConsoleControls):
    return {
        "adjustment_approval_threshold_kes": str(c.adjustment_approval_threshold_kes),
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
        "updated_by": c.updated_by.username if c.updated_by_id else None,
    }


@extend_schema(request=OpenApiTypes.OBJECT, responses={200: OpenApiTypes.OBJECT})
@api_view(["GET", "PATCH"])
@permission_classes(staff("finance.view", write="owner.finance_controls"))
def finance_controls(request):
    controls = ConsoleControls.load()
    if request.method == "GET":
        return Response(_controls_payload(controls))
    raw = request.data.get("adjustment_approval_threshold_kes")
    try:
        value = Decimal(str(raw)).quantize(Decimal("0.01"))
    except (InvalidOperation, TypeError, ValueError):
        return Response({"adjustment_approval_threshold_kes": "Enter an amount in KES."}, status=400)
    if value < 0 or value > Decimal("1000000"):
        return Response({"adjustment_approval_threshold_kes": "Must be between 0 and 1,000,000."}, status=400)
    old = controls.adjustment_approval_threshold_kes
    controls.adjustment_approval_threshold_kes = value
    controls.updated_by = request.user
    controls.save()
    AuditLog.log_action(
        admin=request.user, action="settings_change", resource_type="settings",
        description="Changed the two-person approval threshold for wallet corrections",
        changes={"adjustment_approval_threshold_kes": {"old": str(old), "new": str(value)}},
        request=request,
    )
    return Response(_controls_payload(controls))


# Labels used in the audit trail and the console.
ROLE_NAMES = ROLE_LABELS
__all__ = ["accept_invite", "is_owner"]
