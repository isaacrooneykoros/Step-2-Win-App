# Step2Win anti-cheat: rules, decisions, outcomes

Code: `apps/steps/anti_cheat.py` (engine), `apps/steps/views.py::sync_health` (daily
sync decision path), `apps/steps/views.py::sync_hourly_steps` (hourly buckets + route
check), `apps/steps/verification.py` (user-facing breakdown).
Tests: `apps/steps/tests/test_anticheat_phase0.py` (+ `test_security.py`,
`tests/test_sync_reliability.py`).

## How one daily sync (`POST /api/steps/sync/`) is decided

The phone sends its cumulative **raw** total for a local day (`steps`), plus optional
cadence/burst/gait/ML fields describing a ~3 s sensor snapshot.

1. **Session / replay** (unchanged): unknown or expired session → 400, bad token → 401,
   replayed event id / non-increasing sequence → 400 and the session is rejected.
   Idempotent retries of the same reading → 200 with the current state.
2. **Out-of-order**: a reading older than the last applied one → 200 `stale`, no change.
3. **Non-monotonic** (raw vs raw): a newer reading lower than the last raw total →
   400 + HIGH `non_monotonic_steps` (one open flag per day).
4. **Velocity** (`assess_velocity`, raw vs raw):
   - plausible growth = 4.0 steps/s × elapsed + 600 (sprint ≈ 3.5 steps/s; the Android
     ledger clamps at 4/s; headroom for batching). Elapsed = max(server clock since the
     last accepted sync, phone clock between readings), so a delayed upload is not
     punished.
   - day bound (covers the first sync of a day) = 4.0 steps/s × time since the device's
     local midnight + 2,000. The server does not know the phone's time zone: it assumes
     `STEP_DEVICE_DEFAULT_UTC_OFFSET_HOURS` (default 3, EAT) + 2 h tolerance.
   - anything above the plausible amount is **unverified** (`HealthRecord.unverified_steps`):
     not counted now, credited later as time passes (next syncs). No flag, no 400.
   - **clearly impossible** only: delta > 8 steps/s × elapsed + 5,000, or a total above
     8 steps/s since the earliest possible local midnight (UTC+14) + 5,000 → 400 + HIGH
     `step_velocity_spike` (one open flag per day).
5. **Rule engine** (`evaluate_daily_submission` → `decision_to_check_result`) scores the
   sync. Total-level rules look at the raw day total; snapshot rules look at the steps
   this sync would credit (the plausible delta).
6. **Credit**: credited delta = plausible delta × confidence × status multiplier, added
   to the day. `HealthRecord.steps` (what counts) is capped at 60,000
   (`DAILY_STEP_CAP`); the part above is recorded as `anticheat.over_cap_steps`.
7. **Suspicion** (`is_suspicious`, excludes the day from challenge totals) only on
   strong evidence; sticky per day.
8. **Trust** deductions only for HIGH/CRITICAL evidence, capped per user per day.
9. **Breakdown** for the user (`HealthRecord.verification`, `GET /api/steps/verification/`).

The legacy `STEP_ANTICHEAT_V2_ENABLED` / `_SHADOW_MODE` flags now only label the stored
`DailyVerificationSummary`/`IntervalVerificationResult` rows ("active" vs "shadow"); both
modes run the same engine. The legacy rule that halved a RESTRICT account's credited
delta (with V2 disabled) is **removed**: a low trust score already lowers confidence
(table below), and payout holds (`apps/challenges/payout_holds.py`) stop a REVIEW-or-worse
winner's money reaching the wallet until staff review it, so halving on top was a double
penalty.

## Confidence (how much of a plausible delta is credited)

`confidence = source × trust × pattern` (no blanket base discount any more)

| Factor | Value |
|---|---|
| source `phone_sensor_session` (verified step session on a registered Android/iOS device) | 1.00 |
| source `phone_unsessioned` (user's device is a phone, no step session) | 0.90 |
| source `device_sensor` (legacy `run_anti_cheat` caller, unknown) | 0.90 |
| source `web` | 0.70 |
| client `source` label | can only **lower** it: device_sensor/apple_health 1.00, google_fit 0.90, manual 0.20 |
| trust GOOD / WARN | 1.00 |
| trust REVIEW / RESTRICT / SUSPEND / BAN | 0.90 / 0.75 / 0.40 / 0.00 |
| pattern | 1.0 until risk 10, then 1 − (risk − 10)/180, min 0.35 |

The source key is derived by the server (`resolve_source_key`: session → device
registration platform, else `User.device_platform`), never from the client's `source`.

Status multiplier: risk ≥ 90 or any CRITICAL → REJECT (0, sync blocked with 400);
risk ≥ 70 → REVIEW (0.60); risk ≥ 45 → SOFT_CAP (0.85); else ACCEPT (1.0).

## Rule table

Risk = Σ(score × weight) × trust risk multiplier (GOOD 0.9, WARN 1.0, REVIEW 1.15,
RESTRICT 1.35, SUSPEND 1.7, BAN 2.0), clamped 0..100.
"Applies when": **delta** = steps this sync would credit; **moving window** = the gait
snapshot is not "at rest" (at rest = `gait_state == "idle"` and no step events in the
last minute, i.e. `cadence_spm` 0/None).

| Rule | Severity | score × weight | Applies when |
|---|---|---|---|
| `daily_total_impossible` (> 120,000) | CRITICAL | 1.0 × 60 | always (total) |
| `daily_total_review` (> 70,000) | MEDIUM | 0.4 × 8 | always (total) |
| `steps_per_min_impossible` (> 240 over server-computed active minutes) | CRITICAL | 1.0 × 40 | always |
| `steps_per_min_suspicious` (> 205 since Phase 1b; was 165) | HIGH | 0.8 × 20 | always |
| `cadence_impossible` (> 245 spm) | CRITICAL | 1.0 × 35 | cadence present |
| `cadence_suspicious` (> 205 spm) | MEDIUM | 0.6 × 10 | cadence present |
| `burst_impossible` (> 28 / 5 s) | HIGH | 0.8 × 16 | delta > 0 **and** `burst_source == "live_timed"` |
| `burst_suspicious` (> 18 / 5 s) | MEDIUM | 0.5 × 8 | same |
| `gait_confidence_very_low` (< 20) | HIGH | 0.9 × 16 | delta ≥ 100 **and** moving window |
| `gait_confidence_low` (< 40) | MEDIUM | 0.5 × 8 | delta ≥ 100 and moving window |
| `gait_frequency_out_of_band` (outside 0.8–3 Hz) | MEDIUM | 0.5 × 7 | delta ≥ 100 and moving window |
| `gait_periodicity_low` (autocorr < 0.35) | MEDIUM | 0.6 × 9 | delta ≥ 100 and moving window |
| `gait_interval_variability_high` (> 320 ms) | HIGH | 0.8 × 12 | delta ≥ 100 and moving window |
| `gait_interval_variability_moderate` (> 180 ms) | MEDIUM | 0.5 × 7 | delta ≥ 100 and moving window |
| `gait_peak_run_short` (< 3 peaks / 2 s) | MEDIUM | 0.5 × 8 | delta ≥ 100 and moving window |
| `gait_state_suspicious` | HIGH, shake-positive | 0.8 × 14 | delta > 0 |
| `gait_jerk_high` (> 18) | HIGH | 0.7 × 10 | delta > 0 |
| `gait_rotation_chaotic` (gyro var > 4) | MEDIUM | 0.6 × 8 | delta > 0 |
| `in_hand_high_cadence` (> 185 in hand) | MEDIUM | 0.4 × 6 | delta > 0 |
| `ml_shake_high_probability` (≥ 0.80) | HIGH, shake-positive | 0.9 × 18 | delta > 0 |
| `ml_shake_moderate_probability` (≥ 0.65) | MEDIUM | 0.6 × 9 | delta > 0 |
| `ml_label_shake` (label shake, walk < 0.40) | HIGH, shake-positive | 0.7 × 12 | delta > 0 |
| `ml_walk_high_probability` (≥ 0.70) | LOW (credit) | −0.35 × 7 | always |
| `baseline_spike_hard` (> 10× 14-day raw average) | MEDIUM | 0.7 × 12 | ≥ 7 clean history days |
| `baseline_spike_soft` (> 5×) | MEDIUM | 0.5 × 8 | ≥ 7 clean history days |
| `late_sync` (day > 1 day old) | LOW | ≤ 1.0 × 6 | counted only if another MEDIUM+ hit exists |
| `repeated_pattern` (14-day CV < 0.05) | MEDIUM | 0.5 × 8.4 | ≥ 7 history days |

Neutral observations (no hit, recorded in the sync's explainability `notes`):
`gait_snapshot_at_rest`, `gait_delta_trivial`, `gait_not_measured`,
`burst_untimed_ignored`.

Baseline: most recent days first, raw totals (`last_raw_steps`, falling back to `steps`
for rows written before Phase 0), suspicious days excluded.

Burst timing (documented from the Android code): `DeviceStepCounterPlugin` and
`StepCaptureForegroundService` receive batched `TYPE_STEP_COUNTER` events at
`SENSOR_DELAY_NORMAL`; every step of a batch is stamped with the arrival time (clamped
to 4 steps/s since the previous event) and `burst_steps_5s` counts stamps in the last
5 s. The plugin also takes `max(...)` with `GaitAnalyzer.validatedBurst5s`. A normal
batch therefore looks like a burst. iOS spreads CoreMotion batches evenly over the
elapsed time. No client sends `burst_source` yet, so burst rules are neutral until a
client sends `burst_source: "live_timed"` for bursts built from per-step timestamps.

## Outcomes

| Outcome | When | Effect |
|---|---|---|
| Credit | every accepted sync | plausible delta × confidence × status added; day capped at 60,000 |
| Unverified (pace) | raw growth above the plausible rate | not counted now, credited later as time passes; reason `faster_than_walking_pace` |
| Unverified (volume) | credited day above 60,000 | not counted; `anticheat.over_cap_steps`; reason `daily_limit`; no penalty |
| FraudFlag | HIGH/CRITICAL hits always; MEDIUM hits only when the day is excluded (supporting evidence); LOW never | one open flag per (user, day, rule): later hits update `details.occurrences` and keep the highest severity |
| Day excluded (`is_suspicious`) | **strong evidence**: any CRITICAL, risk ≥ review threshold (45), a shake-positive HIGH hit while crediting steps, or ≥ 2 distinct HIGH rules in one sync | sticky: later clean syncs can't clear it; only an admin (setting `is_suspicious=False`) can. `anticheat.suspicion` records reasons and the contributing `StepSyncEvent` ids |
| Sync rejected (400) | CRITICAL hit or risk ≥ 90; clearly impossible velocity; non-monotonic | nothing credited; flags recorded; CRITICAL also marks the day excluded |
| Trust −8 | HIGH hit(s) that are strong evidence | max one HIGH-equivalent (8) per user per server day |
| Trust −15 | CRITICAL | max 15 per user per server day |
| Trust floor | any sync deduction | never below 21: sync evidence alone never reaches SUSPEND (≤ 20); SUSPEND/BAN stay admin decisions (403 on sync) |
| Trust +1 | sync with no HIGH/CRITICAL hit and no strong evidence | (unchanged; P1a owns recovery policy) |
| Route LOW note | little GPS movement for the steps of the same hours (treadmill/indoor) | informational flag only |
| Route MEDIUM | route far too long for the same hours' steps | flag only |

Hourly route check (`_check_route_against_hours`): route distance of the uploaded
waypoints vs the sum of the phone's hourly buckets for the hours those waypoints cover;
needs ≥ 5 points and ≥ 1,000 steps in those hours. Waypoint dates use the device's local
day: the UTC offset implied by the client's `hour` and the fix time (−12..+14 h, within
±1 day of the UTC date); without an hour, the UTC date.

## Day bookkeeping (`HealthRecord`)

- `steps` — credited (what counts toward challenges unless `is_suspicious`).
- `last_raw_steps` — the phone's last raw total (velocity / non-monotonic / baseline).
- `unverified_steps` — raw steps not (yet) plausible for the elapsed time.
- `anticheat` (internal, JSON): `v` (day format version), `suspicion` {sticky, reasons,
  sync_events, first_at, last_at}, `gait_coverage` {gait_steps, rest_snapshot_steps,
  no_gait_steps, syncs_*} (P1b: null gait is still credited, but coverage is recorded),
  `trust_deductions` {server day: points}, `over_cap_steps`, `reduced_steps`,
  `blocked_uploads`, `velocity` (last excess details), `last_sync`.
- `verification` (user-facing, JSON): see below.

Days written before Phase 0 (no `anticheat.v`) are re-evaluated from scratch on their
next sync (the old engine re-evaluated every sync anyway). A pre-Phase-0 day flagged with
evidence that is still strong (open CRITICAL flag, a shake-positive flag, or ≥ 2 distinct
HIGH gait/ML flags) stays excluded.

## User-facing verification breakdown

`GET /api/steps/verification/?date=YYYY-MM-DD` or `?days=N` (1..14, default 7; the
requesting user's days only). Per day:

```json
{"version": 2, "date": "2026-09-24", "counted_steps": 8600, "goal_steps": 8400,
 "challenge_steps": 7900, "credited_steps": 7900, "unverified_steps": 700,
 "under_review": false,
 "tiers": {"walk_session": 3000, "sensor_verified": 4900, "wearable": 0,
           "earlier_credit": 0, "unverified": 500},
 "reasons": [{"code": "walk_session_verified", "steps_affected": 3000, "severity": "positive", "user_message": "3,000 steps from your walks were verified with GPS."},
             {"code": "vehicle", "steps_affected": 500, "severity": "info", "user_message": "500 steps were counted while you seemed to be travelling in a vehicle or on a bike. ..."}]}
```

`counted_steps` = what the phone reported (raw); `goal_steps` = credited steps (goals,
streaks, XP); `challenge_steps` = money-eligible steps (challenge progress, qualification,
payouts; 0 while under review); `credited_steps` = `challenge_steps` (v1 meaning:
"counts toward challenges"); `unverified_steps` = counted − challenge_steps; `tiers` =
the split of `goal_steps` (Phase 1b, below; `earlier_credit` = grandfathered).

### Reason codes (stable)

| Code | Severity | steps_affected | Message (N = steps) |
|---|---|---|---|
| `walk_session_verified` | positive | walk-session tier | "N steps from your walks were verified with GPS." |
| `sensor_verified` | positive | sensor-verified tier | "N steps were confirmed as walking by your phone's motion sensors." |
| `earlier_credit` | positive | grandfathered tier | "N steps counted before step verification started and count in full." |
| `unverified_no_walking_evidence` | info | steps nothing measured | "N steps were counted while your phone wasn't checking your walking (for example with the app closed for a long time). They count for your goals. Opening the app now and then, or starting a walk, helps your steps count toward challenges." |
| `unverified_motion` | info | steps whose motion didn't look like walking | "N steps came from movement that didn't look like walking, such as the phone being jiggled or resting on something that vibrates. They still count for your goals." |
| `vehicle` | info | steps in a vehicle / on a bike | "N steps were counted while you seemed to be travelling in a vehicle or on a bike. They still count for your goals, but not toward challenges." |
| `device_not_verified` | info | steps from a failed-integrity session (enforce only) | "N steps came from a phone we couldn't verify right now, so they count for your goals but not toward challenges." |
| `app_update_needed` | info | steps from an app without evidence | "N steps came from an app version that can't check walking yet. Update the app so your steps can count toward challenges. They still count for your goals." |
| `under_review` | review | credited steps held | "This day is under review, so its steps don't count toward challenges for now. You don't need to do anything." |
| `faster_than_walking_pace` | info | deferred steps | "N steps arrived faster than walking pace allows and weren't counted toward challenges." |
| `daily_limit` | info | steps above the cap | "Steps above 60,000 in a day aren't counted toward challenges." |
| `partly_verified` | info | steps not credited because of reduced confidence | "N steps couldn't be fully verified, so they count only partly toward challenges." |
| `upload_not_verified` | review | null | "An upload for this day couldn't be verified and wasn't counted." |

Messages never contain rule names, weights, thresholds, risk scores, or words like
"shake", "fraud", "integrity" or "mock".

## Phase 1b: walking evidence, walks, device integrity

Code: `apps/steps/evidence.py` (tiers, day refresh, time zone, active minutes),
`apps/steps/walks.py` + `walk_views.py` (walks), `apps/steps/integrity.py` (Play
Integrity), `apps/steps/views.py::sync_health` (wiring), `apps/steps/verification.py`
("why" breakdown v2). Tests: `apps/steps/tests/test_phase1b.py`.

### Evidence tiers: goals vs money

Every credited step of a day (`HealthRecord.steps`, unchanged by Phase 1b: goals,
streaks and XP keep using it) falls in exactly one tier (`HealthRecord.tier_*`):

| Tier | What | Counts toward challenges |
|---|---|---|
| `grandfathered` | credit the day already had when Phase 1b first saw it (cut-over) | yes |
| `wearable` | reserved for Phase 1c (attested watch / band) | yes |
| `walk_session` | steps of a user-started walk the server verified | yes |
| `sensor_verified` | phone-counter steps covered by on-device walking evidence (Android per-minute gait attribution; iOS CoreMotion, see below) | yes |
| `unverified` | no evidence (app closed and nothing measuring, old app, web), motion that didn't look like walking, vehicle travel, a device failing integrity under the enforce policy | **no** |

`HealthRecord.eligible_steps` = grandfathered + wearable + walk_session +
sensor_verified (never more than `steps`). Challenge progress = the sum of
`coalesce(eligible_steps, steps)` over the challenge window's days that are not under
review (`evidence.challenge_total_steps`): used by the sync-time `Participant.steps`
recompute (`views.recompute_challenge_progress`, also run when a walk or an hourly
upload changes a day's eligibility), by joining a challenge, and therefore by
qualification, tie resolution (`best_day_steps` uses money steps too) and payouts.

`evidence.refresh_day(record)` recomputes a day's tiers, `eligible_steps`, server
active minutes and the breakdown from what is stored; it runs after every sync, walk
finish and hourly upload, so late evidence (a walk verified after the day's syncs)
lands without another step upload.

**The server is the judge.** Client evidence is validated (hours 0..23, non-negative
ints, ≤ 20,000 per hour, proportionally scaled if above), only accepted from the
platform it claims (`android_gait_v1` only from an Android session/user,
`ios_coremotion` only from iOS), capped by the day's credited steps, and can only ever
*lower* eligibility compared with the credited total. A modified client that claims
everything is "verified" is what Play Integrity (enforce) is for.

**iOS:** CoreMotion / CMPedometer counts steps with Apple's motion coprocessor and its
own gait model, so iOS phone steps are `sensor_verified` for now. Phase 1c adds
HealthKit provenance (source device / app) and can tighten this.

### Cut-over and grandfathering (nothing is stripped retroactively)

- A day never synced after the deploy keeps `eligible_steps = NULL`, which counts as
  full credit everywhere (`coalesce(eligible_steps, steps)`).
- The first Phase 1b sync of a day that already had credit stores that credit as
  `grandfathered` (`anticheat.p1b.grandfathered`); only steps credited from then on need
  evidence.
- `STEP_EVIDENCE_CUTOVER_DATE=YYYY-MM-DD` (env): days before it keep full challenge
  credit even when synced later (tiers are still computed and shown). Recommended: set
  it to the day the Phase 1b app update is live in the Play Store / App Store, so users
  on the old app aren't surprised before they could update.
- `STEP_MONEY_REQUIRES_EVIDENCE` (env) is **off by default**: tiers are recorded and shown,
  but every credited step counts toward challenges. Apps already installed can't send
  walking evidence, so switch it on only once the Phase 1b app update is distributed:
  set `STEP_MONEY_REQUIRES_EVIDENCE=true` and `STEP_EVIDENCE_CUTOVER_DATE` to the release
  date. Setting it back to false is the emergency switch.
- Users still on an old app (no evidence) see `app_update_needed`.

### Sync payload (new optional fields, all validated server-side)

`tz_offset_minutes` (−720..840), `tz_name`, `install_id`, `burst_source`
(`live_timed` | `arrival_batched`), `evidence_source` (`android_gait_v1` |
`ios_coremotion`), `evidence_hours` (≤ 24 used): per local hour
`{hour, verified, shake, unknown, vehicle, walk, active_minutes, gait_minutes}`,
cumulative for the day and the install; every counted step of the hour is in exactly
one bucket. `active_minutes` in the payload is ignored.

Per hour the Android app attributes each minute's counter steps from its per-minute
gait verdict (see "Android walking evidence" below): `verified` (walking/running seen and
the counter's cadence agrees with the accelerometer's), `shake` (motion clearly not
walking), `unknown` (nothing measured, inconclusive or a missing sensor: **never**
"shake"), `vehicle` (Activity Recognition IN_VEHICLE / ON_BICYCLE, or vehicle speed
during a walk), `walk` (inside a user-started walk; the walk itself is verified by the
server).

Tier arithmetic (`evidence.compute_tiers`, pure): post = credited − grandfathered;
Android: walk_session = min(verified walks' steps, walk bucket); sensor_verified =
verified bucket (minus hours with server-side vehicle movement) + gait-verified steps
of walks whose route couldn't be checked (no GPS / treadmill) up to the rest of the walk
bucket; iOS: sensor_verified = post − walk_session; no evidence: only verified walks.
Everything is capped at post; the unverified remainder is explained by cause
(device_not_verified → vehicle → unverified_motion → no evidence / app update).

### Reinstall and second phone (install streams)

Each upload belongs to a stream: `install_id` (a random id per app install; a reinstall
gets a new one), else the session's device id. The server keeps each stream's last raw
total (`anticheat.streams_raw`) and the day's raw total is the **max** over streams,
never the sum (two phones in one pocket can't double a day):
- the same stream going down → 400 + HIGH `non_monotonic_steps` (unchanged);
- another stream reporting less than the day already has (fresh install, second phone)
  → 200 `secondary_stream: true`, its evidence is stored, nothing new is credited, **no
  flag**;
- `GET /api/steps/resume/?date=` returns the day's raw total (max over streams). A fresh
  install whose ledger has nothing for today resumes from it (reported total =
  resumed base + steps counted since), so an honest reinstall continues seamlessly.
- Evidence of several streams is merged per hour by taking the stream that covered most
  of that hour (never summed).

### Time zone (replaces the UTC+3 assumption when the phone reports one)

The phone sends `tz_offset_minutes` / `tz_name` with each sync and at step-session /
walk start. The day keeps its first offset; one change per day is accepted (travel,
DST). More changes: the most conservative offset seen (least time since local midnight)
is used and a LOW `timezone_hopping` flag is recorded (informational, no trust or
suspicion effect). With a known offset the velocity day bound uses it with ±30 min
tolerance (instead of EAT + 2 h), and a `date` later than the phone's own local date is
rejected (400). Without an offset the Phase 0 behaviour is unchanged. Today / summary /
weekly views use the user's last reported offset for "today".

### Active minutes (server-computed)

`HealthRecord.active_minutes` = per hour, the minutes the phone saw steps in (evidence
`active_minutes`) bounded by what the hour's steps make plausible (≥ 1 minute per 240
steps, ≤ 1 minute per 30 steps, ≤ 60), else steps / 100; steps not covered by any hour
yet: / 100. The steps-per-minute rules divide the day total by these minutes; the
"suspicious" level moved from 165 to 205 (env `ANTICHEAT_V2_SUSPICIOUS_STEPS_PER_MIN`)
because with real minutes a runner's day can average 180-200 per active minute.

### Vehicles (not a fraud flag)

- Client: Activity Recognition IN_VEHICLE / ON_BICYCLE transitions put the steps of
  those minutes in the `vehicle` bucket; during walks GPS vehicle speed does too.
- Server: GPS segments faster than 7 m/s (≤ 70 m/s; slower or teleport glitches are
  ignored) are kept as vehicle time per local hour, from walks (`WalkSession.vehicle_hours`)
  and from hourly route uploads (`anticheat.vehicle_segments`, deduplicated by fix
  time). An hour with ≥ 10 minutes of vehicle movement moves that hour's `verified`
  evidence to `vehicle`. These steps still count for goals; message `vehicle`.

### "Start a walk" sessions

Opt-in, foreground only, started by the user (Home, challenge detail). Endpoints under
`/api/steps/walks/`: `start/`, `<id>/points/` (≤ 500 per call, ≤ 5,000 per walk),
`<id>/finish/` (idempotent), `<id>/integrity/`, `<id>/`, list, `privacy-zone/`
(GET / PUT / DELETE). One active walk per user (a new start abandons an old one).

Verdict (`walks.decide`, pure; reasons are stable codes with kind messages):
- `walk_mock_location` — any fix from a mock provider (Location.isMock /
  isFromMockProvider) or the app's mock flag → unverified;
- `walk_device_not_verified` — integrity failed under the enforce policy;
- `walk_too_short` — under 2 minutes or 100 steps;
- `walk_cadence_unusual` — more than 4 steps/s or 230 per minute over the walk;
- `walk_vehicle` — more than 20% of the walk at vehicle speed;
- `walk_motion_not_walking` — Android gait called more than 25% of the steps shaking;
- `walk_no_route` / `walk_route_short_for_steps` — fewer than 5 fixes, or a stride
  below 0.30 m (treadmill, indoors, GPS blocked): not route-verified, but the
  **gait-verified steps still count** as `sensor_verified`;
- `walk_route_long_for_steps` — stride above 2.2 m (vehicle / bike);
- otherwise `walk_session_verified`: verified steps = steps − shake-like steps, minus
  the vehicle share, scaled down when GPS covered less than 80% of the walk's duration.
Fast fixes are kept and counted as vehicle time, never silently dropped. A walk belongs
to its start's local day.

Privacy: GPS is on only during a walk (high accuracy). `shared_polyline` (anything
others may see) drops the first and last ~250 m and points in the user's optional home
privacy zone. The zone is stored as salted SHA-256 hashes of the geohash-7 cells
(~150 m) covering the circle (radius 100-1,000 m) — never the coordinates. Retention:
raw points are deleted after `WALK_RAW_POINTS_RETENTION_DAYS` (30) by the scheduled job
`purge-old-walk-points` (03:45 UTC, priority 135, lease 15 min); the simplified route
(Douglas-Peucker, 8 m tolerance, encoded polyline) is kept. Walks left active for a day
are closed as abandoned by the same job.

Background location is gone: `ACCESS_BACKGROUND_LOCATION` is removed from the manifest,
permission flows and settings. The automatic walking service keeps gait evidence only
(no GPS). Location permission is asked at the first walk.

### Device integrity (Google Play Integrity)

- Nonce: `session/start/` returns `integrity_nonce` (= `StepSession.server_nonce`,
  base64url) and `integrity_requested` (Android and the verifier configured); walks
  return their own `integrity_nonce`. The app requests a classic Play Integrity token for
  that nonce and posts it to `session/integrity/` or `walks/<id>/integrity/`.
- The server calls Google's `decodeIntegrityToken` with a service account and checks:
  nonce, package name, token age (≤ 15 min), `appRecognitionVerdict ==
  PLAY_RECOGNIZED` (or an allow-listed signing certificate for builds installed outside
  Play), `MEETS_DEVICE_INTEGRITY` (or `MEETS_BASIC_INTEGRITY` with
  `PLAY_INTEGRITY_ACCEPT_BASIC=True`). Licensing is recorded only. The verdict (no raw
  token) is stored on the session / walk (`integrity_status`, `integrity_verdict`).
- Not configured → every check is `unavailable` (SHADOW by construction). Google
  unreachable → `error`, never blocks.
- Policy: admin setting **Payout review > Device integrity** (`device_integrity_policy`,
  default `shadow`). `enforce`: a day with a failed Android session (sticky for the
  day), or an Android session that sent no token 10 minutes after starting (once the
  verifier is configured), has its post-cut-over steps moved to `unverified`
  (`device_not_verified`): goals only. Never a fraud flag, never a trust change. iOS and
  web are never blocked (no attestation yet).
- Emulator / root / debuggable / ADB heuristics (`device_signals` at session start)
  are stored as shadow signals only (`integrity_verdict.heuristics`).
- `python manage.py integrity_report --days 7` summarises statuses, failure reasons,
  shadow heuristics and the steps enforce would move, to decide when to enforce.

#### Owner setup (Google Cloud / Play Console)

1. Play Console → your app (com.step2win.app) → **Test and release → App integrity →
   Play Integrity API** → **Link a Cloud project** (create a new Google Cloud project or
   choose an existing one). Linking enables the Play Integrity API for that project.
2. Google Cloud console (same project) → **APIs & Services → Library** → check that
   **Google Play Integrity API** is enabled.
3. **IAM & Admin → Service accounts → Create service account** (for example
   `play-integrity-verifier`). No project roles are needed for decoding tokens.
4. Open the service account → **Keys → Add key → Create new key → JSON**. Keep the file
   secret (never commit it).
5. Backend environment (Render → the web service → Environment):
   - `PLAY_INTEGRITY_PACKAGE_NAME=com.step2win.app`
   - `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON=` the JSON file's contents (or its base64)
   - optional `PLAY_INTEGRITY_ALLOWED_CERT_SHA256=` the SHA-256 of your app signing
     certificate (Play Console → App integrity → App signing), only if you also
     distribute APKs outside Play;
   - optional `PLAY_INTEGRITY_ACCEPT_BASIC=True` to accept uncertified phones.
6. Android build: the Cloud **project number** (Cloud console → Dashboard → Project
   info) goes into the app build as `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER` (Gradle
   property or environment variable; see the Android section below), then publish the
   build through Play.
7. Leave the admin policy on **shadow** for at least a week; run `integrity_report`.
   Switch to **enforce** only when failures are rare and understood. Classic requests
   have a default quota of 10,000 per day (the app makes about one per 12-hour step
   session plus one per walk): request a higher quota in Play Console before you need it.
8. Huawei / phones without Google Play services cannot produce tokens: under enforce
   their Android sessions count as unchecked (goals only). Decide before enforcing
   (open question).

#### iOS: App Attest (designed, not implemented)

Needs an Apple Developer account (DeviceCheck / App Attest capability), so it is a
TODO. Design: at first launch the app generates an App Attest key
(`DCAppAttestService.generateKey`), the server issues a challenge (the same
`integrity_nonce`), the app calls `attestKey(keyId, clientDataHash: SHA256(nonce))` and
posts the attestation; the server validates the CBOR attestation against Apple's App
Attest root CA, the app id (`TEAMID.bundleId`), the counter and the nonce, and stores the
public key per install. Later sessions send an assertion
(`generateAssertion(keyId, SHA256(nonce))`) verified with the stored key and a
monotonic counter. Until then iOS sessions stay `unchecked` and are never blocked.

### Burst timing

`burst_source: "live_timed"` only when `burst_steps_5s` is built from real per-event
sensor timestamps (Android `TYPE_STEP_DETECTOR` `SensorEvent.timestamp`); batched
counter events are `arrival_batched`. Burst rules still apply only to `live_timed`.

## Security hygiene

`StepSyncEvent.raw_payload` no longer stores the plaintext `session_token` (replaced by
`"[redacted]"` for accepted and rejected events). Migration `steps.0012` redacts
existing rows.

## Account linkage (Phase 2a, `apps/linkage`)

Multi-account farms, one person carrying several phones, shared devices and collusion.
Code: `detectors.py` (edges), `graph.py` (pair rule, clusters), `store.py` (nightly
recompute), `policy.py` (payout holds), `timeline.py` + `views.py` (staff).
Tests: `apps/linkage/tests/`.

Identity graph: nodes are accounts; an edge is one kind of evidence between two accounts.

| Edge | Strength | Weight | Evidence |
|---|---|---|---|
| `shared_device` | strong | 1.00 | same device id in `DeviceRegistration` (full history of every bound device) |
| `shared_payout_account` | strong | 1.00 | same M-Pesa number / bank / paybill account (user phone, deposits, payouts, withdrawals) where at least one account withdraws or is paid to it |
| `shared_deposit_number` | medium | 0.50 | same M-Pesa number used only for deposits (a parent topping up a child) |
| `shared_business_number` | weak | 0.05 | a payout/deposit number or account shared by more than 10 accounts (`business_number_min_accounts`): a business, agent or till number; context only, shown as "Shared business number (N accounts)" |
| `co_location` | medium | 0.30 / 0.45 / 0.60 | GPS fixes within ~100 m and 5 min for 15+ min on 1 / 2 / 3+ days (`LocationWaypoint`; places with more than 8 accounts ignored) |
| `twin_curves` | medium | 0.30 / 0.45 / 0.60 | near-identical hourly step curves on 1 / 2 / 3+ days (risk_ml `twin_pairs`) |
| `handover` | medium | 0.40 | steps alternate A, B, A in disjoint hours on 2+ days, or daily totals anti-correlated (r ≤ −0.7 over 10+ days); only for pairs with other evidence |
| `joint_challenges` | medium | 0.30 / 0.40 | both qualified in the same 3+ small challenges (≤ 50 participants, last 90 days); 0.40 when they also joined within 30 min each time |
| `phone_sequence` | weak | 0.10 / 0.25 | profile numbers within 99 / 10, registered within 14 days |
| `shared_network` | weak | 0.15 | login from the same public /24 (IPv6 /48), compared by keyed hash (`DeviceSession.network_hash`, 90 days); networks with more than 6 accounts (carrier NAT, campus) and private addresses ignored |

A pair is **linked** when it has a strong edge, or medium evidence adding up to ≥ 1.0
from at least two different kinds. Weak edges never link (review context only).
Clusters = connected components of linked pairs, pairs marked as a known household
left out. Nightly job `linkage-recompute` (23:15 UTC, before the 00:05 UTC settlement)
upserts edges, deactivates edges whose evidence is gone and rebuilds clusters;
idempotent. 5,000 synthetic accounts: ~3 s, ~11 MB peak.

Payout policy (hold reason `linked_accounts`, `payout_holds.hold_reasons`):
1. several accounts of one group in the same paid challenge → every winner but the
   first-registered account is held;
2. the same PHONE (`shared_device`) as an account that received a payout in the last
   180 days (other challenges) → held. A shared payout number alone does not trigger
   this rule (families share M-Pesa numbers; switch
   `strong_link_paid_includes_payout_number` to include it) but still counts for rule 1.
The group also uses strong links computed live at settlement (new or re-bound accounts).
A forfeited prize is never shared with the held account's linked accounts. If the
linkage check itself fails, settlement pays as if there were no link (the other hold
rules still apply), logs at ERROR and sends an ops alert (`OPS_ALERT_WEBHOOK_URL`). Links never
ban, suspend or change steps; the customer sees the standard "being reviewed" message.
Staff can mark accounts as a **known household** (audited) to suppress holds for those
pairs; switches and thresholds are in `LinkageSettings` (Finance > Payout reviews).

Privacy: evidence stores masked identifiers ("ending 123", "…a1b2"), a keyed hash of the
network prefix, counts and dates; never raw numbers, IPs or coordinates. Login IPs
(`apps/users/network_privacy.py`): the full IP is kept only while the session is active
(cleared on logout/revoke/password reset/deletion, when the refresh token expires, and
after 90 days at the latest); only an HMAC of the /24 (/48) is kept for linkage, for 90
days (key `NETWORK_HASH_SECRET`, else derived from SECRET_KEY). Screens show "41.90.x.x".
Nightly job `privacy-ip-retention`; migration `users.0015` converted existing rows. An account's
edges, cluster membership and household marks are deleted when the account is deleted.

## Changelog

### Phase 1b (2026-09-29) — money needs real walking evidence

The direct fix for "shaking the phone produced lots of counted steps": shaken, vehicle
and unmeasured steps still count for goals / streaks / XP, but only evidence-backed
steps count toward challenges and payouts.

1. Evidence tiers per day (`tier_*`, `eligible_steps`); challenge progress, joins,
   qualification, tie-break best day and payouts use money-eligible steps.
2. Android per-minute walking-evidence attribution uploaded as `evidence_hours`
   (server-validated, capped); iOS CoreMotion counts as sensor-verified.
3. "Start a walk" GPS sessions with server consistency checks, mock-location
   detection, vehicle-speed handling, privacy trimming, salted-geohash home zone and
   30-day raw-point retention (scheduled job `purge-old-walk-points`).
4. Play Integrity verifier (shadow by default; admin enforce policy), shadow device
   heuristics, `integrity_report` command; App Attest designed (TODO).
5. Vehicles: Activity Recognition + GPS speed on the phone, vehicle-speed hours on
   the server → `vehicle` (not a fraud flag).
6. Phase 0 follow-ups: client time zone for day bounds (+ LOW `timezone_hopping`);
   `burst_source` `live_timed` only from real per-step timestamps; install streams
   (reinstall / second phone: max per stream, `GET /api/steps/resume/`, no false
   `non_monotonic_steps`); server-computed active minutes (steps-per-minute
   suspicious level 165 → 205).
7. "Why" breakdown v2 (`goal_steps` vs `challenge_steps`, tiers, new kind reasons).
8. Background location removed entirely.

Migrations: `steps.0014_phase1b_evidence_walks` (HealthRecord tiers + eligible steps,
StepSession integrity / time zone / install id, WalkSession, WalkPrivacyZone),
`admin_api.0010_device_integrity_policy`.

### Phase 0 (2026-09-25) — stop hurting honest users

1. Full credit: `device_sensor` fell back to 0.75 and a 0.95 base applied, so every
   approved day was ~74.8% of the phone's count. Source is now server-derived
   (`phone_sensor_session` = 1.0), base 1.0, GOOD trust 1.0; small risk (≤ 10) is free.
   The client `source` label can only lower confidence.
2. Velocity compares raw with raw (`last_raw_steps`), physically sensible rate
   (4 steps/s + headroom, client/server elapsed), first sync bounded by time since local
   midnight, borderline excess kept unverified (credited later) instead of 400 + HIGH;
   only clearly impossible jumps are rejected.
3. Suspicion only on strong evidence; LOW rules never create flags or suspicion; MEDIUM
   only adds risk; suspicion is sticky per day with contributing syncs recorded; a
   suspicion change recomputes challenge totals immediately.
4. Gait snapshot at rest is neutral; "no walking" rules need a non-trivial delta and a
   moving window; shake detections stay effective whenever steps are credited.
5. Burst rules only for `burst_source: "live_timed"` (new optional field).
6. `late_sync` is LOW/informational (weighs only with other evidence).
7. Baseline: most recent days, raw vs raw, ≥ 7 days history, MEDIUM at most.
8. Volume: > 60,000 no longer wipes the day; credit capped at 60,000, rest unverified,
   no penalty; the legacy "10× recent average" exclusion was removed (baseline rule).
9. Trust: only HIGH/CRITICAL strong evidence deducts; max 8 (15 with CRITICAL) per user
   per server day; never below 21 from sync evidence.
10. Route check uses the same hours' steps, treadmill = LOW note, deduplicated flags,
    device-local waypoint dates.
11. `session_token` redacted from stored payloads (+ data migration).
12. Kept: replay/sequence/session checks, non-monotonic, idempotency, impossible
    cadence/steps-per-minute/daily totals, shake detections. All sync FraudFlags are now
    one open flag per (user, day, rule).
13. User-facing verification breakdown (`HealthRecord.verification`,
    `GET /api/steps/verification/`).

Migrations: `steps.0011_healthrecord_anticheat_raw_tracking` (adds
`last_raw_steps`, `unverified_steps`, `anticheat`, `verification`),
`steps.0012_redact_sync_event_session_tokens` (data).

Removed: `backend/test_anticheat.py` (stale manual script; replaced by the tests above).
