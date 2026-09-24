"""
Account deletion endpoints (see apps.users.account_deletion for the policy).

  GET  /api/auth/account/delete/eligibility/  -> {eligible, blockers, requires_password, ...}
  POST /api/auth/account/delete/              {password} or {confirm: "DELETE"}
  GET/POST /account/delete/                   public, no-JS web page (Google Play requirement)
"""

from __future__ import annotations

import logging
import secrets

from django.contrib.auth import authenticate, get_user_model
from django.core.exceptions import PermissionDenied
from django.shortcuts import render
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.throttles import (AccountDeletionRateThrottle,
                                 AccountDeletionWebRateThrottle)

from .account_deletion import (CONFIRM_WORD, AccountDeletionError,
                               check_reauthentication, delete_account,
                               eligibility, get_blockers)

logger = logging.getLogger(__name__)
User = get_user_model()

_BLOCKER = inline_serializer(
    name="AccountDeletionBlocker",
    fields={"code": serializers.CharField(), "message": serializers.CharField()},
)


class AccountDeletionEligibilityView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(
        responses={
            200: inline_serializer(
                name="AccountDeletionEligibility",
                fields={
                    "eligible": serializers.BooleanField(),
                    "blockers": _BLOCKER.__class__(many=True),
                    "requires_password": serializers.BooleanField(),
                    "confirm_word": serializers.CharField(),
                    "social_providers": serializers.ListField(child=serializers.CharField()),
                },
            )
        }
    )
    def get(self, request):
        return Response(eligibility(request.user))


class AccountDeletionView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [AccountDeletionRateThrottle]

    @extend_schema(
        request=inline_serializer(
            name="AccountDeletionRequest",
            fields={
                "password": serializers.CharField(required=False),
                "confirm": serializers.CharField(required=False, help_text="DELETE (accounts without a password)"),
            },
        ),
        responses={
            200: inline_serializer(
                name="AccountDeletionResponse",
                fields={"deleted": serializers.BooleanField(), "message": serializers.CharField()},
            ),
            400: inline_serializer(
                name="AccountDeletionError",
                fields={
                    "error": serializers.CharField(),
                    "code": serializers.CharField(),
                    "blockers": _BLOCKER.__class__(many=True),
                },
            ),
        },
    )
    def post(self, request):
        user = request.user
        blockers = get_blockers(user)
        if blockers:
            return _error(AccountDeletionError(blockers))

        problem = check_reauthentication(
            user,
            password=request.data.get("password"),
            confirm=request.data.get("confirm"),
        )
        if problem:
            code = status.HTTP_403_FORBIDDEN if problem.code == "invalid_password" else status.HTTP_400_BAD_REQUEST
            return Response({"error": problem.message, "code": problem.code, "blockers": []}, status=code)

        try:
            delete_account(user, channel="app")
        except AccountDeletionError as exc:
            return _error(exc)
        return Response(
            {"deleted": True, "message": "Your Step2Win account has been deleted."},
            status=status.HTTP_200_OK,
        )


def _error(exc: AccountDeletionError) -> Response:
    return Response(
        {
            "error": exc.blockers[0].message if len(exc.blockers) == 1 else "Your account can't be deleted yet.",
            "code": exc.code,
            "blockers": [b.as_dict() for b in exc.blockers],
        },
        status=exc.status_code,
    )


# ── Public web page ──────────────────────────────────────────────────────────


def _support_email() -> str:
    try:
        from apps.admin_api.platform import current_settings

        return current_settings().support_email or "support@step2win.com"
    except Exception:
        return "support@step2win.com"


def _render(request, context: dict, status_code: int = 200):
    nonce = secrets.token_urlsafe(16)
    base = {
        "nonce": nonce,
        "support_email": _support_email(),
        "confirm_word": CONFIRM_WORD,
        "identifier": "",
        "state": "form",
    }
    base.update(context)
    response = render(request, "users/account_delete.html", base, status=status_code)
    response["Content-Security-Policy"] = (
        "default-src 'none'; "
        f"style-src 'nonce-{nonce}'; "
        "img-src 'self' data:; "
        "form-action 'self'; "
        "frame-ancestors 'none'; "
        "base-uri 'none'"
    )
    response["X-Robots-Tag"] = "noindex"
    return response


_BAD_CREDENTIALS = (
    "We couldn't sign you in with those details. Check your username, email or phone and "
    "password. If you signed up with Google or Apple, delete your account from the app "
    "instead (see below)."
)


@never_cache
@csrf_protect
@require_http_methods(["GET", "POST"])
def account_delete_page(request):
    if request.method == "GET":
        return _render(request, {})

    throttle = AccountDeletionWebRateThrottle()
    if not throttle.allow_request(request, None):
        return _render(
            request,
            {"error": "Too many attempts. Please wait an hour and try again."},
            status.HTTP_429_TOO_MANY_REQUESTS,
        )

    identifier = (request.POST.get("identifier") or "").strip()[:254]
    password = request.POST.get("password") or ""
    ctx = {"identifier": identifier}
    if not identifier or not password:
        ctx["error"] = "Enter your username or email and your password."
        return _render(request, ctx, status.HTTP_400_BAD_REQUEST)

    account = User.objects.filter(username=identifier).first()
    if account is None and "@" in identifier:
        account = User.objects.filter(email__iexact=identifier).first()
    if account is None and identifier.lstrip("+").isdigit():
        account = User.objects.filter(phone_number=identifier.lstrip("+")).first()

    user = None
    if account is not None:
        try:
            user = authenticate(request, username=account.username, password=password)
        except PermissionDenied:  # django-axes lockout
            user = None
    if user is None:
        ctx["error"] = _BAD_CREDENTIALS
        return _render(request, ctx, status.HTTP_400_BAD_REQUEST)

    blockers = get_blockers(user)
    if blockers:
        ctx.update({"state": "blocked", "blockers": [b.as_dict() for b in blockers]})
        return _render(request, ctx, status.HTTP_409_CONFLICT)

    if request.POST.get("understand") != "yes":
        ctx["error"] = "Tick the box to confirm you understand this can't be undone."
        return _render(request, ctx, status.HTTP_400_BAD_REQUEST)

    try:
        delete_account(user, channel="web")
    except AccountDeletionError as exc:
        ctx.update({"state": "blocked", "blockers": [b.as_dict() for b in exc.blockers]})
        return _render(request, ctx, exc.status_code)
    return _render(request, {"state": "deleted"})
