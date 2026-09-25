"""
Built-in scheduled-job runner (see backend/SCHEDULED_JOBS.md).

One registry, two runners:

* ``settings.CELERY_BEAT_SCHEDULE`` is the single source of truth (task dotted path +
  celery schedule). The built-in runner reads it here; a future Celery beat reads the
  same dict (``step2win/celery.py`` wraps every entry in ``run_scheduled_job``), so
  switching runners never means maintaining two lists.
* Jobs are resolved by import and called as plain functions (never ``.delay``).
* Due check: the schedule's own logic (``crontab.remaining_estimate``) against the
  job's ``last_started_at``. A job with no recorded run is due once. A job that missed
  several slots (server asleep) runs once, not once per missed slot.
* Lease: ``ScheduledJobState.lease_until`` is taken with one conditional UPDATE, so a
  job never runs twice at once across threads, processes or instances. The UPDATE
  also checks that ``last_started_at`` is still what the caller saw, so two runners
  that both saw a job as due cannot run it back to back either.

``JOB_RUNNER`` (env / settings): ``builtin`` (default) = the in-process ticker and the
``/api/internal/jobs/run-due/`` endpoint run jobs; ``celery`` = both are disabled and a
Celery worker with beat runs them; ``off`` = nothing runs automatically.
"""

from __future__ import annotations

import copy
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from importlib import import_module
from typing import Any, Callable

from celery import shared_task
from celery.schedules import BaseSchedule, crontab, schedule as interval_schedule
from django.conf import settings
from django.db import close_old_connections, connection
from django.db.models import F, Q
from django.utils import timezone

logger = logging.getLogger("apps.admin_api.scheduler")

RUNNER_BUILTIN = "builtin"
RUNNER_CELERY = "celery"
RUNNER_OFF = "off"
RUNNERS = (RUNNER_BUILTIN, RUNNER_CELERY, RUNNER_OFF)

MAX_ERROR_CHARS = 2000
MAX_RESULT_CHARS = 255

# Per-job run order and lease. Lower priority runs first when several jobs are due in
# the same tick (money first, nightly analytics last). The lease must cover the job's
# worst-case run time: if a run outlives its lease another runner may start it again.
# Jobs not listed here get DEFAULT_PRIORITY / DEFAULT_LEASE_SECONDS.
DEFAULT_PRIORITY = 500
DEFAULT_LEASE_SECONDS = 30 * 60
JOB_OPTIONS: dict[str, dict[str, int]] = {
    "process-unprocessed-callbacks": {"priority": 10, "lease_seconds": 10 * 60},
    "reconcile-pending-payments": {"priority": 20, "lease_seconds": 20 * 60},
    # Tiebreaker stats (zero-step days, longest streak) must be fresh before payouts.
    "update-participant-consistency": {"priority": 30, "lease_seconds": 30 * 60},
    "finalize-completed-challenges": {"priority": 40, "lease_seconds": 30 * 60},
    "reconcile-financial-integrity": {"priority": 50, "lease_seconds": 10 * 60},
    "escalate-overdue-support-tickets": {"priority": 60, "lease_seconds": 10 * 60},
    "monitor-anticheat-shadow-drift": {"priority": 70, "lease_seconds": 10 * 60},
    "update-user-streaks": {"priority": 80, "lease_seconds": 45 * 60},
    "reset-weekly-xp": {"priority": 85, "lease_seconds": 10 * 60},
    "nightly-fraud-scan": {"priority": 90, "lease_seconds": 45 * 60},
    "monitor-new-non-topup-funded-accounts": {"priority": 100, "lease_seconds": 15 * 60},
    "check-wallet-balance-consistency": {"priority": 110, "lease_seconds": 30 * 60},
    "cleanup-inactive-sessions": {"priority": 120, "lease_seconds": 15 * 60},
    "cleanup-old-suspicious-activities": {"priority": 130, "lease_seconds": 15 * 60},
}


def job_runner() -> str:
    value = str(getattr(settings, "JOB_RUNNER", RUNNER_BUILTIN) or RUNNER_BUILTIN).strip().lower()
    return value if value in RUNNERS else RUNNER_BUILTIN


# ── Registry ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Job:
    name: str
    task: str
    schedule: BaseSchedule
    priority: int = DEFAULT_PRIORITY
    lease_seconds: int = DEFAULT_LEASE_SECONDS
    args: tuple = ()
    kwargs: dict = field(default_factory=dict)

    def resolve(self) -> Callable[..., Any]:
        module_path, _, attr = self.task.rpartition(".")
        return getattr(import_module(module_path), attr)

    def describe(self) -> str:
        return describe_schedule(self.schedule)


def _as_schedule(value) -> BaseSchedule:
    if isinstance(value, BaseSchedule):
        return value
    if isinstance(value, timedelta):
        return interval_schedule(value)
    if isinstance(value, (int, float)):
        return interval_schedule(timedelta(seconds=value))
    raise TypeError(f"Unsupported schedule: {value!r}")


def get_jobs() -> list[Job]:
    """Every job from CELERY_BEAT_SCHEDULE, most urgent first."""
    jobs = []
    for name, entry in (getattr(settings, "CELERY_BEAT_SCHEDULE", {}) or {}).items():
        opts = JOB_OPTIONS.get(name, {})
        jobs.append(
            Job(
                name=name,
                task=entry["task"],
                schedule=_as_schedule(entry["schedule"]),
                priority=int(opts.get("priority", DEFAULT_PRIORITY)),
                lease_seconds=int(opts.get("lease_seconds", DEFAULT_LEASE_SECONDS)),
                args=tuple(entry.get("args", ()) or ()),
                kwargs=dict(entry.get("kwargs", {}) or {}),
            )
        )
    jobs.sort(key=lambda j: (j.priority, j.name))
    return jobs


def get_job(name: str) -> Job | None:
    return next((j for j in get_jobs() if j.name == name), None)


def describe_schedule(sched: BaseSchedule) -> str:
    if isinstance(sched, crontab):
        return (
            f"{sched._orig_minute} {sched._orig_hour} {sched._orig_day_of_month} "
            f"{sched._orig_month_of_year} {sched._orig_day_of_week} (UTC)"
        )
    if isinstance(sched, interval_schedule):
        return f"every {int(sched.run_every.total_seconds())}s"
    return str(sched)


# ── Due logic ───────────────────────────────────────────────────────────────


def _tz(sched: BaseSchedule):
    try:
        return sched.tz or dt_timezone.utc
    except Exception:  # noqa: BLE001
        return dt_timezone.utc


def _in_tz(sched: BaseSchedule, value: datetime) -> datetime:
    """Aware datetime in the schedule's zone (UTC). Celery's crontab reads the wall-clock
    fields of ``last_run_at`` as-is, so a value in another zone would shift the slot."""
    if timezone.is_naive(value):
        value = timezone.make_aware(value, dt_timezone.utc)
    return value.astimezone(_tz(sched))


def _at(sched: BaseSchedule, now: datetime) -> BaseSchedule:
    """A copy of the schedule whose notion of "now" is ``now`` (aware, schedule zone)."""
    clone = copy.copy(sched)
    now = _in_tz(sched, now)
    clone.nowfun = lambda: now
    return clone


def is_due(sched: BaseSchedule, last_started_at: datetime | None, now: datetime | None = None) -> bool:
    """True when the schedule has fired at least once since ``last_started_at``.

    Uses the schedule's own ``remaining_estimate`` (UTC, CELERY_TIMEZONE). No recorded
    run = due once. Many missed slots still mean one run (catch-up, not replay).
    """
    now = now or timezone.now()
    if last_started_at is None:
        return True
    return _at(sched, now).remaining_estimate(_in_tz(sched, last_started_at)).total_seconds() <= 0


def next_run_at(sched: BaseSchedule, last_started_at: datetime | None, now: datetime | None = None) -> datetime:
    """When the job is (or was) next due. In the past (or now) when it is due."""
    now = now or timezone.now()
    if last_started_at is None:
        return now
    return now + _at(sched, now).remaining_estimate(_in_tz(sched, last_started_at))


def nominal_interval(sched: BaseSchedule, now: datetime | None = None) -> timedelta:
    """Gap between two consecutive fire times after ``now`` (for "overdue" display)."""
    now = now or timezone.now()
    now = _in_tz(sched, now)
    first = now + _at(sched, now).remaining_estimate(now)
    probe = first + timedelta(seconds=1)
    second = probe + _at(sched, probe).remaining_estimate(first)
    gap = second - first
    return gap if gap.total_seconds() > 0 else timedelta(days=1)


# ── State and lease ─────────────────────────────────────────────────────────


def tidy_connections() -> None:
    """close_old_connections(), except inside an atomic block (tests, callers' transactions)."""
    if not connection.in_atomic_block:
        close_old_connections()


def _model():
    from apps.admin_api.models import ScheduledJobState

    return ScheduledJobState


def get_state(name: str):
    return _model().objects.get_or_create(name=name)[0]


_ANY = object()


def acquire_lease(name: str, lease_seconds: int, expected_last_started=_ANY, now: datetime | None = None) -> datetime | None:
    """Take the job's lease with one conditional UPDATE.

    Succeeds only when no live lease exists (``lease_until`` NULL or in the past) and,
    when ``expected_last_started`` is given, nobody started the job since the caller
    looked at it. Returns the start time on success, None otherwise.
    """
    Model = _model()
    now = now or timezone.now()
    get_state(name)  # make sure the row exists (get_or_create is race-safe on the unique name)
    qs = Model.objects.filter(name=name).filter(Q(lease_until__isnull=True) | Q(lease_until__lt=now))
    if expected_last_started is not _ANY:
        qs = qs.filter(last_started_at__isnull=True) if expected_last_started is None else qs.filter(
            last_started_at=expected_last_started
        )
    updated = qs.update(lease_until=now + timedelta(seconds=lease_seconds), last_started_at=now)
    return now if updated == 1 else None


def _short(value: Any, limit: int) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, default=str, separators=(",", ":"))
        except Exception:  # noqa: BLE001
            text = str(value)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _finish(name: str, started_at: datetime, status: str, duration_ms: int, error: str = "", result: str = "") -> None:
    Model = _model()
    Model.objects.filter(name=name, last_started_at=started_at).update(
        last_finished_at=timezone.now(),
        last_status=status,
        last_duration_ms=duration_ms,
        last_error=error,
        last_result=result,
        run_count=F("run_count") + 1,
        lease_until=None,
    )


def _announce(name: str, status: str) -> None:
    try:
        from apps.core.realtime import publish_admin_event

        publish_admin_event("jobs.updated", {"name": name, "status": status})
    except Exception:  # noqa: BLE001 - realtime is best effort
        pass


# ── Running ─────────────────────────────────────────────────────────────────


def execute(job: Job, started_at: datetime, trigger: str) -> dict:
    """Run a job whose lease is already held, record the outcome and release the lease."""
    t0 = time.monotonic()
    status, error, result = "ok", "", ""
    tidy_connections()
    try:
        value = job.resolve()(*job.args, **job.kwargs)
        result = _short(value, MAX_RESULT_CHARS)
    except Exception as exc:  # noqa: BLE001 - one failing job never stops the others
        status = "error"
        error = _short(f"{type(exc).__name__}: {exc}", MAX_ERROR_CHARS)
        logger.exception("scheduled_job name=%s trigger=%s status=error", job.name, trigger)
    finally:
        tidy_connections()
    duration_ms = int((time.monotonic() - t0) * 1000)
    try:
        _finish(job.name, started_at, status, duration_ms, error, result)
    except Exception:  # noqa: BLE001 - the lease then simply expires
        logger.exception("scheduled_job name=%s could not record its result", job.name)
    logger.info(
        "scheduled_job name=%s trigger=%s status=%s duration_ms=%d result=%s",
        job.name, trigger, status, duration_ms, result[:120],
    )
    _announce(job.name, status)
    return {"name": job.name, "status": status, "duration_ms": duration_ms}


def run_job(job: Job, *, force: bool = False, trigger: str = "manual", now: datetime | None = None) -> dict:
    """Run one job now if it is due (or ``force``) and its lease is free.

    Returns {"name", "status"} where status is ok | error | not_due | busy.
    """
    now = now or timezone.now()
    state = get_state(job.name)
    if not force and not is_due(job.schedule, state.last_started_at, now):
        return {"name": job.name, "status": "not_due"}
    started = acquire_lease(
        job.name,
        job.lease_seconds,
        expected_last_started=_ANY if force else state.last_started_at,
        now=now,
    )
    if started is None:
        return {"name": job.name, "status": "busy"}
    return execute(job, started, trigger)


def run_due_jobs(budget_seconds: float = 45.0, *, trigger: str = "ticker", jobs: list[Job] | None = None) -> dict:
    """Run every due job, most urgent first, until the time budget is used.

    Jobs still due when the budget runs out are left for the next tick. Returns a
    summary with names, statuses and counts only.
    """
    t0 = time.monotonic()
    summary: dict[str, Any] = {"runner": job_runner(), "ran": [], "busy": [], "deferred": [], "failed_checks": 0}
    if summary["runner"] != RUNNER_BUILTIN and trigger in ("ticker", "endpoint"):
        summary["skipped"] = f"runner is {summary['runner']}"
        return summary
    for job in jobs if jobs is not None else get_jobs():
        try:
            tidy_connections()
            state = get_state(job.name)
            now = timezone.now()
            if not is_due(job.schedule, state.last_started_at, now):
                continue
            if time.monotonic() - t0 >= budget_seconds:
                summary["deferred"].append(job.name)
                continue
            outcome = run_job(job, trigger=trigger, now=now)
        except Exception:  # noqa: BLE001 - e.g. the database blinked; try the rest
            summary["failed_checks"] += 1
            logger.exception("scheduled_job name=%s trigger=%s could not be checked", job.name, trigger)
            continue
        if outcome["status"] == "busy":
            summary["busy"].append(job.name)
        elif outcome["status"] != "not_due":
            summary["ran"].append({"name": job.name, "status": outcome["status"]})
    summary["elapsed_ms"] = int((time.monotonic() - t0) * 1000)
    if summary["ran"] or summary["deferred"] or summary["failed_checks"]:
        logger.info(
            "scheduled_jobs tick trigger=%s ran=%d errors=%d busy=%d deferred=%d elapsed_ms=%d",
            trigger,
            len(summary["ran"]),
            sum(1 for r in summary["ran"] if r["status"] == "error"),
            len(summary["busy"]),
            len(summary["deferred"]),
            summary["elapsed_ms"],
        )
    return summary


def job_rows(now: datetime | None = None) -> list[dict]:
    """Admin view of every job: schedule, last run, next due, overdue."""
    now = now or timezone.now()
    states = {s.name: s for s in _model().objects.all()}
    rows = []
    for job in get_jobs():
        s = states.get(job.name)
        last = s.last_started_at if s else None
        interval = nominal_interval(job.schedule, now)
        overdue = last is None or (now - last) > 2 * interval
        running = bool(s and s.lease_until and s.lease_until > now and (not s.last_finished_at or s.last_finished_at < last))
        rows.append(
            {
                "name": job.name,
                "task": job.task,
                "schedule": job.describe(),
                "priority": job.priority,
                "lease_seconds": job.lease_seconds,
                "interval_seconds": int(interval.total_seconds()),
                "last_started_at": last,
                "last_finished_at": s.last_finished_at if s else None,
                "last_status": (s.last_status if s else "") or None,
                "last_duration_ms": s.last_duration_ms if s else None,
                "last_error": (s.last_error if s else "") or None,
                "last_result": (s.last_result if s else "") or None,
                "run_count": s.run_count if s else 0,
                "running": running,
                "next_due_at": next_run_at(job.schedule, last, now),
                "due": is_due(job.schedule, last, now),
                "overdue": overdue,
            }
        )
    return rows


@shared_task(name="scheduler.run_scheduled_job")
def run_scheduled_job(name: str) -> dict:
    """Celery entry point (JOB_RUNNER=celery). Beat fires it on the same schedule; the
    shared due check and lease mean a slot another runner already handled (or is
    handling) is skipped instead of run twice."""
    if job_runner() == RUNNER_OFF:
        return {"name": name, "status": "skipped"}
    job = get_job(name)
    if job is None:
        return {"name": name, "status": "unknown"}
    return run_job(job, trigger="celery")


def celery_beat_schedule() -> dict:
    """CELERY_BEAT_SCHEDULE rewritten so every entry runs through ``run_scheduled_job``."""
    out = {}
    for name, entry in (getattr(settings, "CELERY_BEAT_SCHEDULE", {}) or {}).items():
        out[name] = {"task": "scheduler.run_scheduled_job", "schedule": entry["schedule"], "args": (name,)}
    return out
