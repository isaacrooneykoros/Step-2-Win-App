"""
Scheduled jobs: the internal cron trigger and the staff views (see SCHEDULED_JOBS.md).

* POST /api/internal/jobs/run-due/  - called by GitHub Actions every 10 minutes with
  header X-Cron-Token = CRON_SECRET. No cookies/JWT. 404 when CRON_SECRET is unset,
  403 on a wrong token, 409 when JOB_RUNNER is not builtin. Answers with names,
  statuses and counts only.
* GET  /api/admin/monitoring/jobs/            - staff: every job with its last run.
* POST /api/admin/monitoring/jobs/<name>/run/ - staff: "Run now" (audited, lease-bound).
"""

from __future__ import annotations

import hmac
import logging
import threading

from django.conf import settings
from django.db import connections
from django.utils import timezone
from drf_spectacular.utils import OpenApiTypes, extend_schema
from rest_framework import permissions, status
from rest_framework.decorators import (api_view, authentication_classes,
                                       permission_classes, throttle_classes)
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle

from apps.admin_api import scheduler
from apps.admin_api.models import AuditLog
from apps.admin_api.views import IsAdminUser

logger = logging.getLogger("apps.admin_api.scheduler")

ENDPOINT_BUDGET_SECONDS = 45


class InternalJobsGlobalThrottle(SimpleRateThrottle):
    """One small bucket for the whole endpoint (the caller is a single cron)."""

    scope = "internal_jobs"

    def get_rate(self):
        rates = getattr(self, "THROTTLE_RATES", {}) or {}
        return rates.get(self.scope) or "20/minute"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": "global"}


@extend_schema(exclude=True)
@api_view(["POST"])
@authentication_classes([])
@permission_classes([permissions.AllowAny])
@throttle_classes([InternalJobsGlobalThrottle])
def run_due_jobs_endpoint(request):
    secret = getattr(settings, "CRON_SECRET", "") or ""
    if not secret:
        return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)
    token = request.headers.get("X-Cron-Token", "") or ""
    if not hmac.compare_digest(token.encode("utf-8"), secret.encode("utf-8")):
        logger.warning("scheduled_jobs endpoint: rejected token from %s", request.META.get("REMOTE_ADDR"))
        return Response({"detail": "Forbidden."}, status=status.HTTP_403_FORBIDDEN)
    runner = scheduler.job_runner()
    if runner != scheduler.RUNNER_BUILTIN:
        return Response({"detail": f"runner is {runner}", "runner": runner}, status=status.HTTP_409_CONFLICT)
    summary = scheduler.run_due_jobs(ENDPOINT_BUDGET_SECONDS, trigger="endpoint")
    return Response(
        {
            "runner": runner,
            "ran": summary["ran"],
            "busy": summary["busy"],
            "deferred": summary["deferred"],
            "counts": {
                "ran": len(summary["ran"]),
                "ok": sum(1 for r in summary["ran"] if r["status"] == "ok"),
                "error": sum(1 for r in summary["ran"] if r["status"] == "error"),
                "busy": len(summary["busy"]),
                "deferred": len(summary["deferred"]),
            },
            "elapsed_ms": summary.get("elapsed_ms", 0),
        }
    )


ADMIN = [permissions.IsAuthenticated, IsAdminUser]


@extend_schema(responses={200: OpenApiTypes.OBJECT})
@api_view(["GET"])
@permission_classes(ADMIN)
def scheduled_jobs(request):
    return Response(
        {
            "runner": scheduler.job_runner(),
            "cron_configured": bool(getattr(settings, "CRON_SECRET", "")),
            "timestamp": timezone.now(),
            "jobs": scheduler.job_rows(),
        }
    )


def _run_in_background(job, started_at, trigger):
    def target():
        try:
            scheduler.execute(job, started_at, trigger)
        finally:
            connections.close_all()

    threading.Thread(target=target, name=f"run-now-{job.name}", daemon=True).start()


# Tests swap this for an inline runner.
RUN_NOW_EXECUTOR = _run_in_background


@extend_schema(request=None, responses={202: OpenApiTypes.OBJECT})
@api_view(["POST"])
@permission_classes(ADMIN)
def run_scheduled_job_now(request, name):
    job = scheduler.get_job(name)
    if job is None:
        return Response({"detail": "Unknown job."}, status=status.HTTP_404_NOT_FOUND)
    if scheduler.job_runner() == scheduler.RUNNER_OFF:
        return Response({"detail": "runner is off"}, status=status.HTTP_409_CONFLICT)
    started = scheduler.acquire_lease(job.name, job.lease_seconds)
    if started is None:
        return Response({"detail": "This job is already running."}, status=status.HTTP_409_CONFLICT)
    AuditLog.log_action(
        admin=request.user,
        action="run_job",
        resource_type="system",
        resource_name=job.name,
        description=f"Ran scheduled job {job.name} manually",
        changes={"job": job.name, "task": job.task},
        request=request,
    )
    RUN_NOW_EXECUTOR(job, started, "admin")
    return Response({"name": job.name, "status": "started", "started_at": started}, status=status.HTTP_202_ACCEPTED)
