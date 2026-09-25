# Risk model (shadow): synthetic evaluation

**Read this first.** Every number here comes from *synthetic* users I generated
(`apps/risk_ml/synthetic.py`). The same person wrote the cheat scenarios, the honest archetypes,
the features and the evidence checks, all from the same threat model. So a good result here only
shows that the plumbing works end to end: data in, features, forest, evidence, reasons out. It does
**not** tell you how well the model will work on real users. Treat these numbers as an upper bound.
The first real measurement will be the shadow scores compared with admin decisions on actual
payouts.

Reproduce (writes nothing to the database):

```
python manage.py risk_ml_synthetic_eval            # pure-Python forest (production path)
python manage.py risk_ml_synthetic_eval --sklearn  # needs requirements-ml.txt
```

## Setup

- **190 synthetic users.** 30 in each of five honest archetypes, and 6 in each of five cheat
  archetypes. The farm archetype is 2 farms of 5 accounts.
- **28 unlabelled "history" days.** The isolation forest is trained on these, the same way it
  would be in production (no labels). Then **7 evaluation days** follow, inside a paid 7-day
  challenge with a 70,000-step milestone.
- **Honest archetypes:**
  - **student**: about 7k steps a day, a weekday/weekend pattern, some GPS walks.
  - **runner**: a 9.5k-step 6 AM run three days a week, cadence 165–182, bursts up to 17 in 5 seconds.
  - **worker_35k**: about 3.2k steps an hour, 07:00–18:00, six days a week.
  - **treadmill**: a 5k-step gym hour three times a week, with GPS stuck in the gym.
  - **rural_late_sync**: an iPhone (no motion data), a farm-work day, uploads 1–3 days late.
- **Cheat archetypes:**
  - **phone_shaker**: 4.5–7k steps an hour for 3–6 evening or overnight hours, on about 80% of
    evaluation days. Motion data appears in only half of those syncs.
  - **script**: the same hourly curve and a round total every day. Half the scripts also send
    fake "perfect" gait data.
  - **vehicle_vibration**: 2.2–4k steps an hour, 4 hours a day, while riding at 15–60 km/h.
  - **account_farm**: 5 accounts replay the same day with ±15 steps of jitter per hour. They also
    share a phone, M-Pesa numbers and a phone-number prefix.
- **Evasive cheats** (reported, but not in the headline numbers):
  - **subtle_shaker**: adds 3–5k shaken steps in the afternoon, with the app closed.
  - **noisy_script**: imitates a student's day with random noise and non-round totals.
- **GPS matches the real client.** Synthetic waypoints go through the Android capture filter
  (`StepCaptureForegroundService`: any fix implying more than 8 m/s from the last kept fix is
  dropped). So road travel above about 29 km/h leaves no GPS trace. This mirrors what the server
  actually receives.

A cheat user's non-cheat days count as "not cheating" in the metrics.

## Results (seed 7, pure-Python forest, 100 trees)

| scorer | ROC AUC | at 0.5: precision / recall / honest-day FPR | at 0.7: precision / recall / honest-day FPR | evasive cheats caught at 0.5 |
|---|---:|---|---|---:|
| **combined** (evidence + forest, production) | 1.000 | 0.95 / 0.98 / 0.01 | 0.99 / 0.92 / 0.002 | 0% |
| evidence only (no trained forest yet) | 0.999 | 0.95 / 0.97 / 0.01 | 0.99 / 0.75 / 0.002 | 0% |
| forest only (rarity percentile) | 0.996 | 0.23 / 1.00 / 0.56 | 0.37 / 1.00 / 0.29 | 44% |

Cross-check with a scikit-learn forest (same features, `--sklearn`) at 0.7: combined precision
0.99, recall 0.96, FPR 0.002. Evidence only: recall 0.75. Forest only: FPR 0.27. So the two
trainers behave the same.

Combined scorer by archetype (score 0–1):

| archetype | days | median | p10 | p90 | most common top reasons |
|---|---:|---:|---:|---:|---|
| account_farm | 70 | 0.93 | 0.82 | 0.96 | twin_accounts, shared_mpesa, phone_cluster |
| script | 42 | 0.98 | 0.96 | 0.98 | twin_accounts, identical_curve |
| phone_shaker | 35 | 0.87 | 0.84 | 0.90 | volume_spike, burst, night_steps |
| vehicle_vibration | 32 | 0.79 | 0.52 | 0.92 | volume_spike, vehicle_speed (20 of 32 days) |
| subtle_shaker (evasive) | 35 | 0.00 | 0.00 | 0.00 | - |
| noisy_script (evasive) | 42 | 0.00 | 0.00 | 0.00 | - |
| treadmill | 210 | 0.00 | 0.00 | 0.42 | little_movement, volume_spike |
| runner | 210 | 0.00 | 0.00 | 0.30 | volume_spike, deadline_surge |
| worker_35k | 210 | 0.00 | 0.00 | 0.00 | - |
| student | 210 | 0.00 | 0.00 | 0.00 | - |
| rural_late_sync | 210 | 0.00 | 0.00 | 0.00 | - |

Example reasons, as an admin sees them:

- **Phone shaker (0.85):** "9.8x your usual daily steps (33,976 vs a typical 3,464); up to 36
  steps in 5 seconds (7.2 per second; brisk walking is about 2); 29% of steps between 1 and 4 AM".
- **Script (0.98):** "hourly steps match 5 other accounts almost exactly today; hourly pattern
  repeats an earlier day almost exactly (only 0.0% of steps fall in different hours; real routines
  vary more); the same daily total (10,000) as 7 of the previous 7 days".
- **Vehicle (0.89):** "49% of steps were counted while moving at vehicle speed (around 29 km/h);
  4.6x your usual daily steps".
- **Farm (0.93):** "hourly steps match 4 other accounts almost exactly today; the M-Pesa number is
  also used by 4 other accounts; 4 other accounts with near-sequential phone numbers joined within
  two weeks".
- **Treadmill, an honest false positive (0.37):** "GPS moved only 0.01 km per 1,000 steps (walking
  covers about 0.7 km; a treadmill also looks like this); 2.1x your usual daily steps".

A test (`tests/test_scoring.py::SyntheticRankingTests`) runs a smaller population with a different
seed. It asserts three things:

- AUC is at least 0.95.
- Every cheat archetype's median is above the 90th percentile of every honest archetype.
- The honest false-positive rate at 0.7 is at most 2%.

## What this does and doesn't show

**The forest alone is not usable.** At a useful recall it flags 30–55% of honest days. The rural
iPhone user (no motion data, late uploads) and the runner come out as "rare", because rare is not
the same as dishonest. It has value only as one input: in the combined score it lifts the shakers
from 0.67 to 0.87 and the vehicle riders from 0.63 to 0.79. The forest is weighted to count only
above the 95th rarity percentile, and it never explains a day on its own terms.

**The evidence checks do most of the work, and they are hand-written.** They encode the threat
model: personal-baseline spikes, 1–4 AM share, shake probability, identical curves across days and
accounts, shared phone and M-Pesa, vehicle speed. That makes them explainable. It also means they
are only as good as the scenarios I thought of.

**Careful cheats get through completely** (0% of evasive cheat days caught). Examples: a few
thousand shaken steps in the afternoon with the app closed, or a script that adds noise. Server-side
statistics can't separate these from a slightly more active honest day. They need device-side
evidence: attestation, signed sensor summaries, and a trained on-device classifier (see
ON_DEVICE_PLAN.md).

**Vehicle detection is limited by the client.** The Android app drops GPS fixes above 8 m/s, so
only slow town travel (15–29 km/h) is visible. 12 of 32 vehicle days had no usable GPS evidence
and were caught only by the volume spike. A rider who does this every day builds a high baseline,
and the volume check then goes quiet. Fix on the client: keep fast fixes, flagged, or send the
Activity Recognition IN_VEHICLE state.

**Known honest false positives:**

- Treadmill users: GPS doesn't move. This is capped at about 0.35–0.42.
- Runners on long-run days: a volume spike, especially near a deadline.
- New users: no baseline, so their volume checks are off, which cuts both ways.
- Shared family phones: this reads as "phone registered to 2 accounts".

Each of these produces an explicit reason sentence, so a reviewer can see why.

**Real data differs in ways the generator doesn't model:**

- Stored `HealthRecord.steps` is the discounted approved total (about 75% of the phone's count,
  per the audit).
- Batched step-counter events inflate the burst figures.
- Gait data is a 3-second snapshot, not a summary of the credited steps.
- The late-sync and velocity rules reject honest uploads, which inflates the rejection counts.

The feature definitions try to be robust to this. For example, rejections carry little weight,
late syncs aren't evidence at all, and route distance is compared with the steps of the same hours
only. Still, expect the real score distribution to look different. Recalibrate on real data (train
the forest on the feature store) before reading anything into the scores.

**Before any enforcement:**

- Collect at least 4–8 weeks of shadow scores.
- Compare them against admin payout-review decisions (the HeldPayout labels).
- Measure the honest-user false-positive rate at the candidate hold threshold.
- Train the supervised model only once there are enough labels of both classes (see
  `risk_ml_train_supervised`, which refuses until then).
