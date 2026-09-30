"""
Privacy endpoints.

Customer (JWT):
  GET  /api/privacy/consents/                 current consents, what is missing, policy versions
  POST /api/privacy/consents/                 {"consents": {"location_walks": true}, "source": "walk_start"}
  GET  /api/privacy/exports/                  my export requests
  POST /api/privacy/exports/                  ask for a copy of my data (1 per 24 h)
  GET  /api/privacy/exports/<id>/download/    the ZIP (owner only, until it expires)
  GET  /api/privacy/summary/                  what we keep and for how long (for the Privacy screen)

Staff:
  GET/PATCH /api/privacy/admin/settings/      retention periods, export limits, consent minimums
"""

from __future__ import annotations

from django.http import HttpResponse
from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import IsAdminUser, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import UserRateThrottle

from . import consent as consent_mod
from .export import ExportRateLimited, request_export
from .models import DataExportRequest, PrivacySettings


class PrivacyWriteThrottle(UserRateThrottle):
    scope = "privacy_write"
    rate = "30/hour"

    def get_rate(self):  # rate lives on the class: no settings entry needed
        return self.rate


class ExportDownloadThrottle(UserRateThrottle):
    scope = "privacy_export_download"
    rate = "20/hour"

    def get_rate(self):
        return self.rate


def _export_dict(req: DataExportRequest) -> dict:
    now = timezone.now()
    ready = req.status == DataExportRequest.STATUS_READY and req.expires_at and req.expires_at > now
    return {
        "id": str(req.id),
        "status": "expired" if req.status == DataExportRequest.STATUS_READY and not ready else req.status,
        "requested_at": req.requested_at,
        "finished_at": req.finished_at,
        "expires_at": req.expires_at,
        "size_bytes": req.size_bytes if ready else 0,
        "download_path": f"/api/privacy/exports/{req.id}/download/" if ready else None,
    }


def _app_version(request) -> str:
    return str(request.headers.get("X-App-Version") or request.data.get("app_version") or "")[:32]


@extend_schema(request=None, responses=None)
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def consents(request):
    if request.method == "GET":
        return Response(consent_mod.overview(request.user))
    if PrivacyWriteThrottle().allow_request(request, None) is False:
        return Response({"error": "Too many changes. Try again later.", "code": "throttled"}, status=429)
    changes = request.data.get("consents")
    source = str(request.data.get("source") or "settings")
    try:
        consent_mod.apply_changes(request.user, changes, source=source, app_version=_app_version(request))
    except consent_mod.ConsentError as exc:
        return Response({"error": exc.message, "code": exc.code}, status=exc.status_code)
    return Response(consent_mod.overview(request.user))


@extend_schema(request=None, responses=None)
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def exports(request):
    s = PrivacySettings.load()
    if request.method == "GET":
        rows = DataExportRequest.objects.filter(user=request.user).defer("archive")[:5]
        return Response(
            {
                "exports": [_export_dict(r) for r in rows],
                "cooldown_hours": s.export_cooldown_hours,
                "link_hours": s.export_link_hours,
            }
        )
    try:
        req, created = request_export(request.user)
    except ExportRateLimited as exc:
        return Response(
            {
                "error": "You asked for a copy of your data recently. You can ask again after "
                f"{exc.retry_after:%d %b %Y %H:%M} UTC.",
                "code": "export_rate_limited",
                "retry_after": exc.retry_after,
            },
            status=429,
        )
    return Response(_export_dict(req), status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


@extend_schema(request=None, responses=None)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
@throttle_classes([ExportDownloadThrottle])
def export_download(request, export_id):
    # Owner only: someone else's id answers exactly like a missing one.
    req = DataExportRequest.objects.filter(pk=export_id, user=request.user).first()
    if req is None:
        return Response({"error": "Not found.", "code": "not_found"}, status=404)
    now = timezone.now()
    if req.status != DataExportRequest.STATUS_READY or not req.archive:
        if req.status in (DataExportRequest.STATUS_EXPIRED,) or (
            req.status == DataExportRequest.STATUS_READY and not req.archive
        ):
            return Response({"error": "This download has expired. Ask for a new copy.", "code": "expired"}, status=410)
        return Response({"error": "Your data is still being prepared.", "code": "not_ready"}, status=409)
    if not req.expires_at or req.expires_at <= now:
        DataExportRequest.objects.filter(pk=req.pk).update(status=DataExportRequest.STATUS_EXPIRED, archive=None)
        return Response({"error": "This download has expired. Ask for a new copy.", "code": "expired"}, status=410)
    DataExportRequest.objects.filter(pk=req.pk).update(
        download_count=req.download_count + 1, last_downloaded_at=now
    )
    response = HttpResponse(bytes(req.archive), content_type="application/zip")
    response["Content-Disposition"] = f'attachment; filename="step2win-my-data-{req.finished_at:%Y%m%d}.zip"'
    response["Cache-Control"] = "no-store"
    response["X-Content-Type-Options"] = "nosniff"
    return response


@extend_schema(request=None, responses=None)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def summary(request):
    """Plain-language retention summary for Settings > Privacy (values follow the settings)."""
    s = PrivacySettings.load()

    def days(value: int, text: str, off: str = "Kept while your account is open") -> str:
        return text.format(n=value) if value else off

    return Response(
        {
            "retention": [
                {"key": "account", "title": "Account and profile",
                 "text": "Kept while your account is open. Deleting your account removes it."},
                {"key": "steps", "title": "Daily and hourly steps",
                 "text": "Kept while your account is open, so your history and challenges work."},
                {"key": "sync_details", "title": "Detailed step upload data",
                 "text": days(s.sync_payload_days, "Reduced to daily totals after {n} days.")},
                {"key": "walk_points", "title": "Raw GPS points of walks",
                 "text": "Deleted 30 days after the walk. The simplified route stays in your history."},
                {"key": "login_ips", "title": "Sign-in network details",
                 "text": "Your full IP address is kept only while you're signed in on that device; a "
                 "one-way code of your network is deleted after 90 days."},
                {"key": "fair_play", "title": "Fair-play checks",
                 "text": days(s.risk_ml_days, "Automated fair-play scores are deleted after {n} days.")},
                {"key": "money", "title": "Wallet, M-Pesa payments and payouts",
                 "text": "Kept for 7 years after the transaction, as the law requires for financial "
                 "records, even after you delete your account (without your contact details)."},
            ],
            "export": {"cooldown_hours": s.export_cooldown_hours, "link_hours": s.export_link_hours},
        }
    )


# ── Staff ────────────────────────────────────────────────────────────────────


@extend_schema(request=None, responses=None)
@api_view(["GET", "PATCH"])
@permission_classes([IsAdminUser])
def admin_settings(request):
    s = PrivacySettings.load()
    if request.method == "GET":
        return Response(_admin_payload(s))
    errors = {}
    updates = {}
    for key, value in (request.data or {}).items():
        if key not in PrivacySettings.EDITABLE:
            errors[key] = "Not editable."
            continue
        if key in PrivacySettings.NULLABLE and value in (None, ""):
            updates[key] = None
            continue
        current = getattr(s, key)
        if isinstance(current, bool):
            if not isinstance(value, bool):
                errors[key] = "Must be true or false."
                continue
            updates[key] = value
            continue
        try:
            number = int(value)
        except (TypeError, ValueError):
            errors[key] = "Must be a whole number."
            continue
        lo, hi = PrivacySettings.BOUNDS.get(key, (0, 10**6))
        if key == "walk_raw_points_days":
            hi = min(hi, PrivacySettings.walk_points_max_days())
        if number == 0 and key in PrivacySettings.ZERO_DISABLES:
            updates[key] = 0
        elif not lo <= number <= hi:
            errors[key] = f"Must be between {lo} and {hi}" + (" (or 0 to switch off)." if key in PrivacySettings.ZERO_DISABLES else ".")
        else:
            updates[key] = number
    if errors:
        return Response({"error": "Invalid settings.", "fields": errors, **errors}, status=400)
    before = s.as_dict()
    for key, value in updates.items():
        setattr(s, key, value)
    s.updated_by = request.user
    s.save()
    try:
        from apps.admin_api.models import AuditLog

        AuditLog.objects.create(
            admin=request.user,
            admin_username=request.user.username,
            action="settings_change",
            resource_type="settings",
            resource_name="Privacy settings",
            description="Privacy settings changed",
            changes={k: [before.get(k), v] for k, v in updates.items() if before.get(k) != v},
        )
    except Exception:  # noqa: BLE001 - audit is best effort here; the change itself is saved
        pass
    return Response(_admin_payload(s))


def _admin_payload(s: PrivacySettings) -> dict:
    """Stored values plus what the server enforces (for the console's explanations)."""
    from django.conf import settings as dj

    return {
        **s.as_dict(),
        "server": {
            "walk_raw_points_days": int(getattr(dj, "WALK_RAW_POINTS_RETENTION_DAYS", 30)),
            "walk_raw_points_max_days": PrivacySettings.walk_points_max_days(),
            "walk_raw_points_effective_days": s.effective_walk_raw_points_days(),
        },
        "updated_at": s.updated_at,
        "updated_by": s.updated_by.username if s.updated_by_id else None,
    }
