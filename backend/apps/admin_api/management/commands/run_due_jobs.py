"""Run scheduled jobs by hand (troubleshooting, or an external cron). See SCHEDULED_JOBS.md.

    python manage.py run_due_jobs                 # every due job, 45 s budget
    python manage.py run_due_jobs --list          # show each job's state
    python manage.py run_due_jobs --job NAME      # one job now, due or not (lease still applies)
"""

import json

from django.core.management.base import BaseCommand, CommandError

from apps.admin_api import scheduler


class Command(BaseCommand):
    help = "Run due scheduled jobs (or one job with --job) through the built-in runner."

    def add_arguments(self, parser):
        parser.add_argument("--job", help="Run this job now, even if it is not due.")
        parser.add_argument("--budget", type=float, default=45.0, help="Seconds before no new job starts.")
        parser.add_argument("--list", action="store_true", help="List jobs and their last run.")

    def handle(self, *args, **opts):
        if opts["list"]:
            for row in scheduler.job_rows():
                self.stdout.write(
                    f"{row['name']:<40} {row['schedule']:<28} last={row['last_started_at']} "
                    f"status={row['last_status']} due={row['due']} overdue={row['overdue']}"
                )
            return
        if opts["job"]:
            job = scheduler.get_job(opts["job"])
            if job is None:
                raise CommandError(f"Unknown job {opts['job']!r}")
            self.stdout.write(json.dumps(scheduler.run_job(job, force=True, trigger="command")))
            return
        self.stdout.write(json.dumps(scheduler.run_due_jobs(opts["budget"], trigger="command"), default=str))
