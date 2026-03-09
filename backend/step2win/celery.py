from __future__ import absolute_import, unicode_literals
import os
from celery import Celery
from celery.schedules import crontab

# Set the default Django settings module for the 'celery' program.
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'step2win.settings')

app = Celery('step2win')

# Using a string here means the worker doesn't have to serialize
# the configuration object to child processes.
app.config_from_object('django.conf:settings', namespace='CELERY')

# Load task modules from all registered Django apps.
app.autodiscover_tasks()

# Configure periodic tasks
app.conf.beat_schedule = {
    'finalize-completed-challenges': {
        'task': 'apps.steps.tasks.finalize_completed_challenges',
        'schedule': crontab(hour=0, minute=5),  # Run daily at 00:05
    },
    'nightly-fraud-scan': {
        'task': 'apps.steps.tasks.nightly_fraud_scan',
        'schedule': crontab(hour=2, minute=0),
    },
}

@app.task(bind=True)
def debug_task(self):
    print(f'Request: {self.request!r}')
