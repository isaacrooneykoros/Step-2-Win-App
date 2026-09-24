"""Public "Forgot password" endpoints — logic and security notes in password_reset.py."""

from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.throttles import (PasswordResetConfirmRateThrottle,
                                 PasswordResetIdentifierRateThrottle,
                                 PasswordResetRateThrottle,
                                 PasswordResetVerifyRateThrottle)
from apps.users import password_reset as svc
from apps.users.auth_views import get_client_ip

_ERROR = inline_serializer(
    name="PasswordResetError",
    fields={
        "error": serializers.CharField(),
        "code": serializers.CharField(),
        "attempts_left": serializers.IntegerField(required=False),
        "errors": serializers.DictField(required=False),
    },
)


class _PublicView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []  # a stale bearer token must not turn this into a 401


class PasswordResetRequestView(_PublicView):
    throttle_classes = [PasswordResetRateThrottle, PasswordResetIdentifierRateThrottle]

    @extend_schema(
        request=inline_serializer(
            name="PasswordResetRequest", fields={"identifier": serializers.CharField()}
        ),
        responses={
            200: inline_serializer(
                name="PasswordResetRequestResponse",
                fields={
                    "message": serializers.CharField(),
                    "code_length": serializers.IntegerField(),
                    "expires_in": serializers.IntegerField(),
                    "resend_after": serializers.IntegerField(),
                },
            ),
            400: _ERROR,
        },
    )
    def post(self, request):
        identifier = svc.normalise_identifier(request.data.get("identifier"))
        if not identifier:
            return Response(
                {"error": "Enter your email, username or phone number.", "code": "identifier_required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        svc.request_reset(identifier, ip=get_client_ip(request) or None)
        return Response(
            {
                "message": svc.GENERIC_REQUEST_MESSAGE,
                "code_length": svc.CODE_LENGTH,
                "expires_in": int(svc.CODE_TTL.total_seconds()),
                "resend_after": 60,
            }
        )


class PasswordResetVerifyView(_PublicView):
    throttle_classes = [PasswordResetVerifyRateThrottle]

    @extend_schema(
        request=inline_serializer(
            name="PasswordResetVerify",
            fields={"identifier": serializers.CharField(), "code": serializers.CharField()},
        ),
        responses={
            200: inline_serializer(
                name="PasswordResetVerifyResponse",
                fields={"reset_token": serializers.CharField(), "expires_in": serializers.IntegerField()},
            ),
            400: _ERROR,
        },
    )
    def post(self, request):
        try:
            token = svc.verify_code(request.data.get("identifier"), request.data.get("code"))
        except svc.ResetError as err:
            return Response(err.as_dict(), status=err.status_code)
        return Response({"reset_token": token, "expires_in": int(svc.TOKEN_TTL.total_seconds())})


class PasswordResetConfirmView(_PublicView):
    throttle_classes = [PasswordResetConfirmRateThrottle]

    @extend_schema(
        request=inline_serializer(
            name="PasswordResetConfirm",
            fields={
                "reset_token": serializers.CharField(),
                "new_password": serializers.CharField(),
                "confirm_password": serializers.CharField(),
            },
        ),
        responses={
            200: inline_serializer(
                name="PasswordResetConfirmResponse", fields={"message": serializers.CharField()}
            ),
            400: _ERROR,
        },
    )
    def post(self, request):
        try:
            svc.confirm_reset(
                request.data.get("reset_token"),
                request.data.get("new_password"),
                request.data.get("confirm_password"),
            )
        except svc.ResetError as err:
            return Response(err.as_dict(), status=err.status_code)
        return Response(
            {"message": "Your password has been changed. Sign in with your new password."}
        )
