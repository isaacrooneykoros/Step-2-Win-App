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
| `steps_per_min_impossible` (> 240 over active minutes) | CRITICAL | 1.0 × 40 | always |
| `steps_per_min_suspicious` (> 165) | HIGH | 0.8 × 20 | always |
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
{"version": 1, "date": "2026-09-24", "counted_steps": 64000, "credited_steps": 60000,
 "unverified_steps": 4000, "under_review": false,
 "reasons": [{"code": "faster_than_walking_pace", "steps_affected": 3200,
              "severity": "info", "user_message": "3,200 steps arrived faster than walking pace allows and weren't counted toward challenges."}]}
```

`counted_steps` = what the phone reported; `credited_steps` = what counts toward
challenges (0 while under review); `unverified_steps` = counted − credited.

### Reason codes (stable)

| Code | Severity | steps_affected | Message |
|---|---|---|---|
| `under_review` | review | credited steps held | "This day is under review, so its steps don't count toward challenges for now. You don't need to do anything." |
| `faster_than_walking_pace` | info | deferred steps | "N steps arrived faster than walking pace allows and weren't counted toward challenges." |
| `daily_limit` | info | steps above the cap | "Steps above 60,000 in a day aren't counted toward challenges." |
| `partly_verified` | info | steps not credited because of reduced confidence | "N steps couldn't be fully verified, so they count only partly toward challenges." |
| `upload_not_verified` | review | null | "An upload for this day couldn't be verified and wasn't counted." |

Messages never contain rule names, weights, thresholds or risk scores.

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
| `co_location` | medium | 0.30 / 0.45 / 0.60 | GPS fixes within ~100 m and 5 min for 15+ min on 1 / 2 / 3+ days (`LocationWaypoint`; places with more than 8 accounts ignored) |
| `twin_curves` | medium | 0.30 / 0.45 / 0.60 | near-identical hourly step curves on 1 / 2 / 3+ days (risk_ml `twin_pairs`) |
| `handover` | medium | 0.40 | steps alternate A, B, A in disjoint hours on 2+ days, or daily totals anti-correlated (r ≤ −0.7 over 10+ days); only for pairs with other evidence |
| `joint_challenges` | medium | 0.30 / 0.40 | both qualified in the same 3+ small challenges (≤ 50 participants, last 90 days); 0.40 when they also joined within 30 min each time |
| `phone_sequence` | weak | 0.10 / 0.25 | profile numbers within 99 / 10, registered within 14 days |
| `shared_network` | weak | 0.15 | login from the same public /24 (IPv6 /48) via `DeviceSession.ip_address`; networks with more than 6 accounts (carrier NAT, campus) and private addresses ignored |

A pair is **linked** when it has a strong edge, or medium evidence adding up to ≥ 1.0
from at least two different kinds. Weak edges never link (review context only).
Clusters = connected components of linked pairs, pairs marked as a known household
left out. Nightly job `linkage-recompute` (23:15 UTC, before the 00:05 UTC settlement)
upserts edges, deactivates edges whose evidence is gone and rebuilds clusters;
idempotent. 5,000 synthetic accounts: ~3 s, ~11 MB peak.

Payout policy (hold reason `linked_accounts`, `payout_holds.hold_reasons`):
1. several accounts of one group in the same paid challenge → every winner but the
   first-registered account is held;
2. a strong link to an account that received a payout in the last 180 days (other
   challenges) → held.
The group also uses strong links computed live at settlement (new or re-bound accounts).
A forfeited prize is never shared with the held account's linked accounts. Links never
ban, suspend or change steps; the customer sees the standard "being reviewed" message.
Staff can mark accounts as a **known household** (audited) to suppress holds for those
pairs; switches and thresholds are in `LinkageSettings` (Finance > Payout reviews).

Privacy: evidence stores masked identifiers ("ending 123", "…a1b2"), a keyed hash of the
network prefix, counts and dates; never raw numbers, IPs or coordinates. An account's
edges, cluster membership and household marks are deleted when the account is deleted.

## Changelog

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
