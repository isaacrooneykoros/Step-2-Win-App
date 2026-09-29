# apps.social: friends, teams, weekly rankings, feed

Bragging rights only. **No money, entry fees, prizes or payouts anywhere in social**,
and nothing here reads or writes wallets. Owner rule: build the social layer freely;
don't attach money to a competitive leaderboard until anti-cheat is enforced.

## Which steps rank (one-line switch)

`rankings.py`: `RANKING_STEPS_FIELD = "steps"` is the single place that decides which
`HealthRecord` field is a day's ranking steps. `ranking_steps(user, date)` and the
batch `weekly_steps_by_user()` both read it, through `ranking_records()` which drops
excluded days (`is_suspicious=True`). When Phase 1b adds money-eligible (verified)
steps per day, change that one line to the new field name.

Ranked users: active, not deleted, `show_in_rankings` on, trust score > 20.
Weeks: Monday to Sunday on the Africa/Nairobi calendar.

## Jobs (settings.CELERY_BEAT_SCHEDULE, scheduler.JOB_OPTIONS)

| Job | When (UTC) | What |
|---|---|---|
| social-refresh-weekly-totals | every 10 min | changed users only (HealthRecord.synced_at watermark), team totals, feed milestones |
| social-reconcile-weekly-totals | 01:45 | same, full recompute of the open weeks |
| social-finalize-week | Mon 09:00 (12:00 EAT) | archive last week: friends-rank snapshots, team ranks, weekly badges, "weekly results" notices |

## Customer API (`/api/social/`)

| Method | Path | |
|---|---|---|
| GET/PATCH | `me/` | friend code, privacy (`discoverability`), what to share, notification prefs, feature flags |
| POST | `me/reset-code/` | new friend code (old links stop working) |
| GET | `users/search/?q=` | >= 3 chars, prefix match, max 10, respects "who can find me"; throttled 30/min |
| GET | `users/code/<code>/` | person behind a friend code / QR / link |
| GET | `friends/` | friends with this week's steps |
| DELETE | `friends/<user_id>/` | remove friend |
| GET/POST | `friends/requests/` | incoming + outgoing; POST `{user_id}` or `{code}` (20/hour, daily cap in settings) |
| POST | `friends/requests/<id>/accept|decline|cancel/` | |
| GET/POST | `blocks/`, DELETE `blocks/<user_id>/` | block hides both people from each other everywhere |
| POST | `reports/` | `{target_type: user|team, user_id|team_id, reason, details?, block?}` (10/hour) |
| GET | `rankings/friends/?week=current|previous|YYYY-MM-DD` | rank, steps, movement vs last week, `is_me` |
| GET | `rankings/teams/?week=` | top 50 teams + my teams |
| GET | `rankings/history/` | my archived weeks + weekly wins |
| GET/POST | `teams/` | my teams / create |
| GET | `teams/discover/?q=` | public teams |
| POST | `teams/join-by-code/` | `{code}` |
| GET/PATCH/DELETE | `teams/<id>/` | detail with members ranking / edit (owner, admin) / disband (owner) |
| POST | `teams/<id>/join|leave|reset-code|transfer/` | |
| POST | `teams/<id>/members/<user_id>/remove|role/` | |
| GET | `feed/?before=` | friends' milestones (30 days) |
| POST | `feed/<id>/react/` | `{kind: cheer|fire|strong|clap|null}` |
| GET | `notifications/`, `notifications/summary/`; POST `notifications/read/` | in-app inbox; the app polls `summary` |

## Admin API (`/api/admin/social/`, staff only, audited)

`settings/` (GET/PATCH), `overview/`, `reports/?status=`, `reports/<id>/resolve/`
(`{status: actioned|dismissed, note}` closes every open report on the same target),
`teams/?q=&filter=reported|disabled`, `teams/<id>/moderate/` (`{action: rename|disable|enable, name?, reason?}`).

## Account deletion

`deletion.delete_social_data()` is called by `apps.users.account_deletion`.
