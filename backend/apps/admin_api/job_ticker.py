"""
In-process ticker for the built-in job runner (JOB_RUNNER=builtin).

A daemon thread, started once per web process from ``step2win/asgi.py`` and only when
the process is the daphne web server (never in manage.py commands, migrations, tests or
shells). Every ~60 s (with jitter) it runs the due jobs within a time budget. The lease
in ``scheduler.acquire_lease`` makes it safe next to the GitHub trigger, other web
processes or a Celery worker. It never raises into the web process, closes its own DB
connections after every tick, and stops when the process exits.

It gives minute-level timing while the server is awake. While Render's free instance
sleeps nothing runs in-process; the GitHub Actions workflow (scheduled-jobs.yml) wakes
the server and calls /api/internal/jobs/run-due/ every 10 minutes to cover that.
"""

from __future__ import annotations

import atexit
import logging
import os
import random
import sys
import threading

logger = logging.getLogger("apps.admin_api.scheduler")

TICK_SECONDS = 60
TICK_JITTER_SECONDS = 10
TICK_BUDGET_SECONDS = 45
STARTUP_DELAY_SECONDS = (15, 30)

_lock = threading.Lock()
_ticker: "JobTicker | None" = None


def is_daphne_process(argv: list[str] | None = None) -> bool:
    """True when this process is the daphne server (``daphne ...`` or ``python -m daphne``)."""
    argv = sys.argv if argv is None else argv
    if not argv:
        return False
    first = argv[0].replace("\\", "/").lower()
    base = first.rsplit("/", 1)[-1]
    for suffix in (".exe", "-script.py", ".py"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
    return base == "daphne" or first.endswith("daphne/__main__.py")


def should_start(argv: list[str] | None = None, runner: str | None = None) -> bool:
    from apps.admin_api.scheduler import RUNNER_BUILTIN, job_runner

    argv = sys.argv if argv is None else argv
    if (runner or job_runner()) != RUNNER_BUILTIN:
        return False
    if os.getenv("JOB_TICKER_DISABLED", "").strip().lower() in ("1", "true", "yes"):
        return False
    if "test" in argv[1:2]:
        return False
    return is_daphne_process(argv)


class JobTicker(threading.Thread):
    def __init__(self, interval: float = TICK_SECONDS, jitter: float = TICK_JITTER_SECONDS, budget: float = TICK_BUDGET_SECONDS, startup_delay: float | None = None):
        super().__init__(name="scheduled-jobs-ticker", daemon=True)
        self.interval = interval
        self.jitter = jitter
        self.budget = budget
        self.startup_delay = random.uniform(*STARTUP_DELAY_SECONDS) if startup_delay is None else startup_delay
        self._stop_event = threading.Event()
        self.ticks = 0

    def stop(self, timeout: float = 5.0) -> None:
        self._stop_event.set()
        if self.is_alive() and threading.current_thread() is not self:
            self.join(timeout)

    @property
    def stopped(self) -> bool:
        return self._stop_event.is_set()

    def tick(self) -> None:
        from django.db import connections

        from apps.admin_api.scheduler import run_due_jobs

        try:
            run_due_jobs(self.budget, trigger="ticker")
        except Exception:  # noqa: BLE001 - the ticker must never take the server down
            logger.exception("scheduled_jobs ticker error")
        finally:
            self.ticks += 1
            try:
                connections.close_all()  # this thread's connections only
            except Exception:  # noqa: BLE001
                pass

    def run(self) -> None:
        logger.info("scheduled_jobs ticker started interval=%ss budget=%ss", self.interval, self.budget)
        if self._stop_event.wait(self.startup_delay):
            return
        while not self._stop_event.is_set():
            self.tick()
            wait = max(0.0, self.interval + random.uniform(-self.jitter, self.jitter))
            if self._stop_event.wait(wait):
                break
        logger.info("scheduled_jobs ticker stopped")


def start_ticker_if_enabled(argv: list[str] | None = None) -> "JobTicker | None":
    """Start the ticker once per process when this is the daphne server and JOB_RUNNER=builtin."""
    global _ticker
    try:
        if not should_start(argv):
            return None
        with _lock:
            if _ticker is not None and _ticker.is_alive():
                return _ticker
            _ticker = JobTicker()
            _ticker.start()
            atexit.register(stop_ticker)
            return _ticker
    except Exception:  # noqa: BLE001
        logger.exception("scheduled_jobs ticker could not start")
        return None


def stop_ticker() -> None:
    global _ticker
    with _lock:
        ticker, _ticker = _ticker, None
    if ticker is not None:
        ticker.stop()
