from __future__ import absolute_import, unicode_literals

import os

from celery import Celery
from celery.schedules import crontab

# Set the default Django settings module for the 'celery' program.
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "step2win.settings")

app = Celery("step2win")

# Using a string here means the worker doesn't have to serialize
# the configuration object to child processes.
app.config_from_object("django.conf:settings", namespace="CELERY")

# Load task modules from all registered Django apps.
app.autodiscover_tasks()


@app.on_after_finalize.connect
def _use_scheduled_job_wrapper(sender, **kwargs):
    """Beat runs every CELERY_BEAT_SCHEDULE entry through scheduler.run_scheduled_job,
    so Celery shares the built-in runner's lease and job state (no double runs, same
    admin visibility). Only used with JOB_RUNNER=celery; see SCHEDULED_JOBS.md."""
    from apps.admin_api.scheduler import celery_beat_schedule

    # Namespaced key: with namespace="CELERY" the Django setting name wins over
    # conf.beat_schedule.
    sender.conf.update(CELERY_BEAT_SCHEDULE=celery_beat_schedule())


@app.task(bind=True)
def debug_task(self):
    print(f"Request: {self.request!r}")
