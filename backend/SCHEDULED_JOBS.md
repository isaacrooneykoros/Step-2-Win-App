# Scheduled jobs

Step2Win has background jobs (payment reconciliation, callback retries, challenge
finalization, nightly integrity checks...). Production runs on one Render **free** web
instance with no Celery worker, so the web service runs the jobs itself. The same job
list moves to a paid Celery worker later without code changes.

## How it works

```
settings.CELERY_BEAT_SCHEDULE          one list of jobs (task path + crontab, UTC)
        |
apps/admin_api/scheduler.py            registry, due check, lease, run_due_jobs()
        |
        +-- in-process ticker          daemon thread in the daphne web process, every ~60 s
        |   (apps/admin_api/job_ticker.py)
        +-- POST /api/internal/jobs/run-due/   GitHub Actions, every 10 min, 24/7
        |   (.github/workflows/scheduled-jobs.yml, header X-Cron-Token)
        +-- scheduler.run_scheduled_job        Celery beat later (JOB_RUNNER=celery)
        +-- manage.py run_due_jobs             by hand / troubleshooting
```

* **Due check.** Each job has a row in `ScheduledJobState` (`admin_api_scheduledjobstate`).
  A job is due when its crontab fired since `last_started_at` (Celery's own
  `crontab.remaining_estimate`, UTC). A job that never ran is due once. After the server
  slept through several slots the job runs **once** (catch-up), not once per missed slot.
* **Lease.** Before running, a runner takes the job's lease with one conditional
  `UPDATE ... WHERE lease_until IS NULL OR lease_until < now AND last_started_at = <what it saw>`.
  Only the runner that updated the row runs the job, so the ticker, the GitHub call, a
  second web process, a staff "Run now" and a Celery worker never run the same job at the
  same time or twice for one slot. The lease is released when the job finishes; if the
  process dies mid-run the lease simply expires (per-job length in `JOB_OPTIONS`).
* **Order and budget.** Due jobs run one after another, most urgent first (payments and
  callbacks before nightly analytics). Each run of `run_due_jobs` has a time budget
  (45 s); jobs still due when it is spent run on the next tick. One failing job never
  stops the others; the error is stored on its row.
* **Visibility.** Admin console > Ops monitoring > *Scheduled jobs*: status, last run,
  duration, next due, overdue (not run for more than 2x its interval), the error, and a
  *Run now* button (staff only, audited, respects the lease). The card updates live via
  the `jobs.updated` realtime event.
* **Logs.** One line per job: `scheduled_job name=... trigger=ticker|endpoint|admin|celery|command status=ok|error duration_ms=...`.

Why both triggers: the ticker gives minute-level timing while the server is awake. The
free instance sleeps after ~15 min without traffic; the GitHub workflow calls the
endpoint every 10 minutes, which wakes it (so it rarely sleeps at all) and runs whatever
is due. GitHub's schedule can be a few minutes late; jobs then run a few minutes late,
never twice.

## Jobs

All times UTC. Priority = order within one tick (lower first).

| Job | Schedule | Priority | Lease | Notes |
|---|---|---|---|---|
| process-unprocessed-callbacks | every 5 min | 10 | 10 min | Retries logged gateway callbacks. Idempotent: each callback re-reads its transaction under a row lock and skips final states. |
| reconcile-pending-payments | every 30 min | 20 | 20 min | Asks IntaSend about stale pending deposits/payouts/withdrawals. Every settlement re-reads the row under lock and acts only on a still-pending row. |
| update-participant-consistency | 00:05 | 30 | 30 min | Tiebreaker stats; runs before finalization. Recomputes values (idempotent). |
| finalize-completed-challenges | 00:05 | 40 | 30 min | Pays out ended challenges. Row lock + `status == "active"` guard: each challenge once. Also runs lazily when users open challenge screens. |
| reconcile-financial-integrity | every 10 min | 50 | 10 min | Read-only checks + ops webhook alert. |
| escalate-overdue-support-tickets | every 15 min | 60 | 10 min | Escalates once per waiting episode. |
| monitor-anticheat-shadow-drift | every 30 min | 70 | 10 min | Read-only + alert. |
| update-user-streaks | 00:15 | 80 | 45 min | Same streak rule as the step sync; batched. |
| reset-weekly-xp | Mon 00:00 | 85 | 10 min | Resets only profiles not yet reset this ISO week (safe late or twice). |
| nightly-fraud-scan | 02:00 | 90 | 45 min | Two aggregate queries; flags are get_or_create per user/day/type. |
| monitor-new-non-topup-funded-accounts | 02:20 | 100 | 15 min | Read-only + email alert. |
| check-wallet-balance-consistency | 02:30 | 110 | 30 min | Releases orphaned locked balances under a row lock (second run is a no-op). |
| cleanup-inactive-sessions | 03:00 | 120 | 15 min | Deletes old inactive sessions / blacklisted tokens. |
| cleanup-old-suspicious-activities | 03:30 | 130 | 15 min | Deletes *reviewed* suspicious-activity rows older than 90 days. |

To add a job: add an entry to `CELERY_BEAT_SCHEDULE` (task dotted path + `crontab`), and
optionally a priority/lease in `scheduler.JOB_OPTIONS`. The task must be safe to run late
and twice.

## Environment

| Variable | Where | Value |
|---|---|---|
| `JOB_RUNNER` | Render web service | `builtin` (default when unset). `celery` = ticker and endpoint off (endpoint answers 409 `runner is celery`), a Celery worker runs the jobs. `off` = nothing runs automatically. |
| `CRON_SECRET` | Render web service **and** GitHub repository secret | Same long random value on both. Unset on Render = the endpoint answers 404. |
| `JOB_TICKER_DISABLED` | optional | `1` stops the in-process ticker only (the endpoint still works). |

The ticker starts only in the daphne server process (`render-start.sh`), never in
`manage.py` commands, migrations, tests or shells.

## Setup (free, now)

1. Generate a secret: `python -c "import secrets; print(secrets.token_urlsafe(48))"`.
2. Render dashboard > `step2win-backend` > Environment: add `CRON_SECRET` = that value
   and `JOB_RUNNER` = `builtin`. Save (Render redeploys).
3. GitHub > repository > Settings > Secrets and variables > Actions > New repository
   secret: name `CRON_SECRET`, same value.
4. GitHub > Actions > *Scheduled jobs* > Run workflow. The log should show
   `Jobs run: {"runner":"builtin","ran":[...]...}`.
5. Admin console > Ops monitoring > Scheduled jobs: every job should show a last run
   within a day (nightly jobs) or minutes (frequent ones).

Budget: pinging every 10 minutes 24/7 keeps the free instance awake (~744 instance
hours/month of the 750 free hours per workspace; keep other free services in the
workspace asleep). GitHub pauses scheduled workflows after 60 days without repository
activity: re-enable it from the Actions tab if the card shows everything overdue.

## Moving to a paid Celery worker later

1. Render > New > **Background Worker** (Starter), same repo, root directory `backend`.
   * Build command: `pip install -r requirements.txt`
   * Start command: `celery -A step2win worker -B -l info --concurrency 2`
     (`-B` embeds beat; run exactly one such worker. Beat uses
     `django_celery_beat`'s DatabaseScheduler and every entry calls
     `scheduler.run_scheduled_job`, so the lease and job state are shared.)
   * Environment: copy the web service's variables (at least `DJANGO_ENV`, `DEBUG`,
     `SECRET_KEY`, `DATABASE_URL`/`DATABASE_POOL_URL`, `REDIS_URL`, IntaSend keys,
     `OPS_ALERT_WEBHOOK_URL`, email settings) and set
     `CELERY_BROKER_URL` = the existing Render Key Value (Redis) **internal** URL
     (`redis://red-xxxx:6379`), `USE_REDIS=True`, `JOB_RUNNER=celery`.
2. On the web service set `JOB_RUNNER=celery` (turns off the ticker; the endpoint answers
   409). Deploy both.
3. Optional: disable the GitHub workflow, or keep it as a keep-warm ping (a 409 is
   reported as a notice, not a failure).
4. Check the Scheduled jobs card: runs now appear with trigger `celery` in the worker logs.

Rolling back: set `JOB_RUNNER=builtin` on the web service and stop the worker.

## Troubleshooting

* **Everything overdue.** Check the GitHub workflow is enabled and green, `CRON_SECRET`
  matches on both sides (a mismatch fails the workflow with HTTP 403), and
  `JOB_RUNNER` is `builtin`. `curl -X POST -H "X-Cron-Token: $CRON_SECRET" https://step-2-win-app.onrender.com/api/internal/jobs/run-due/`
  shows what ran.
* **404 from the endpoint.** `CRON_SECRET` is not set on Render.
* **409 `runner is celery` / `runner is off`.** `JOB_RUNNER` on the web service.
* **One job failing.** Expand it on the card for the error; fix, then *Run now*. Or on the
  Render shell: `python manage.py run_due_jobs --job <name>`; `--list` shows every job.
* **A job stuck "Running".** The process died mid-run; the lease expires after the job's
  lease length and the next tick runs it. A redeploy does not clear leases early (by design).
* **Logs.** Render logs, search `scheduled_job` / `scheduled_jobs`.
