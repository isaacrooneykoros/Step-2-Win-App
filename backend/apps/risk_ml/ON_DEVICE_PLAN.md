# Plan: a trained on-device walk/shake classifier (documentation only)

## Today

`GaitAnalyzer.MotionClassifier` (Android, `shakewalk-logreg-v1`) is a softmax over three logits:
walk, shake and a constant "other". The weights are written by hand, for example
`2.40 * freqBandScore`. No data was ever used to fit or check them.

Its inputs are features `GaitAnalyzer` already computes over a 3 s window, refreshed every 500 ms,
from LINEAR_ACCELERATION + GRAVITY + gyroscope at about 50 Hz:

- dominant frequency
- autocorrelation
- step-interval standard deviation
- gyro variance
- jerk RMS
- peak-to-peak amplitude
- candidate cadence
- valid peaks in 2 s
- the state machine's state

`carryMode` is inferred from gyro variance.

The server only receives a snapshot of the last window with each sync. iOS sends nothing.

The goal is to replace the hand-set weights with a model trained on labelled recordings. Keep it
equally tiny (a logistic model or a few shallow trees, evaluated in Java with no ML library),
versioned, and shadow-evaluated before anything depends on it.

## 1. Data collection: an opt-in labelled capture mode

- **Who.** Staff and invited testers only. Enable it per account from the admin console. The
  existing `SystemSettings` or a staff flag would do. Show a clear consent screen: what is
  recorded, for how long it is kept, and how to delete it.
- **What the tester does.** Pick a label, press start, do the activity for 2–5 minutes, press stop.
  Labels:
  - walking, running, stairs
  - treadmill
  - shaking by hand
  - shaker or pendulum rig
  - phone on a vehicle seat or dashboard (matatu, boda, car)
  - sitting or fidgeting
  - pocket, bag or in hand, recorded as carry mode, separate from the activity
- **What is recorded.** Per 3 s window, the feature vector `GaitAnalyzer` already produces. Also
  the step-counter delta for the window, the label, the carry mode, device model and Android
  version, and the app version.
  - Optional (off by default): the raw 50 Hz IMU samples for a subset of sessions, so new
    features can be engineered later. Raw IMU is larger and more sensitive, so cap it and delete it
    after 90 days.
  - Never record GPS coordinates in this mode. Speed from Activity Recognition, or a vehicle yes/no
    flag, is enough.
- **Where it goes.** A separate upload endpoint and table, for example
  `risk_ml.MotionCaptureSession` plus `MotionCaptureWindow`. Keep it apart from real step syncs,
  and keep it out of challenges, trust and payouts. Account deletion removes it, the same way
  `signals.py` removes risk features today.
- **How much.** Aim for at least 20 people and at least 10 phone models, including cheap Android
  handsets (the user base). Collect 30+ minutes per activity class and about 20k windows in total
  before trusting any number. Collect the adversarial classes (shaker rig, vehicle) deliberately;
  they will never appear in organic data with labels.

## 2. Public data (verified licences; used for pre-training or sanity checks only)

- **UCI "Human Activity Recognition Using Smartphones"** (archive.ics.uci.edu dataset 240):
  - CC BY 4.0
  - 30 subjects
  - Samsung Galaxy S II accelerometer and gyroscope at 50 Hz, the same rate as `GaitAnalyzer`
  - walking, stairs up and down, sitting, standing, laying
- **UCI "WISDM Smartphone and Smartwatch Activity and Biometrics"** (dataset 507):
  - CC BY 4.0
  - 51 subjects
  - phone and watch accelerometer and gyroscope at 20 Hz
  - 18 activities

Neither dataset contains shaking, shaker rigs, vehicles or treadmills, so neither can teach the
hard classes. They are useful for:

- checking that the walk/not-walk boundary holds across people. Resample WISDM to 50 Hz and
  recompute the `GaitAnalyzer` features with the same Java code, run in a JVM test harness.
- a first honest estimate of how often real walking is misread as "shake".

Attribute them as the licence requires if they are used. I did not verify any other dataset's
licence, so none is listed.

## 3. Training (offline)

- **Code.** A script next to `risk_ml/tools/`, run in the `requirements-ml.txt` environment.
- **Split by person, not by window.** Use leave-subjects-out or grouped K-fold. Windows from one
  person are highly correlated, and a window-level split overstates accuracy.
- **Also hold out whole phone models.** This tests robustness to new hardware.
- **Models.** Multinomial logistic regression on the existing features (a direct replacement for
  today's weights). Also try gradient-boosted trees with at most 30 trees of depth 3 or less. Pick
  the simplest model within about 1 point of the best macro-F1.
- **Metrics per class and per carry mode.** Honest walking misclassified as shake is the costly
  error, so report it separately: the "honest-walk false-shake rate" in pocket, bag and hand.
  Report shake and vehicle recall at that operating point.
- **Calibration.** Check a reliability plot. The server uses probabilities, not just labels.
- **Model card.** Record the same things as `training.py` writes: data window, subjects, devices,
  metrics, known biases (for example "few bag recordings", "no iPhones").

## 4. Export to the app

- **Format.** The same JSON shapes as `apps/risk_ml/ml/runtime.py` (`logreg` / `gbt`): feature
  order, means and scales, coefficients or tree arrays. Export with `ml/export_sklearn.py`, then
  evaluate in Java with a port of the roughly 40-line runtime.
- **Parity test.** Reuse the pattern of `tests/fixtures/sklearn_parity.json`: probe vectors plus
  the expected probabilities, checked in a JVM unit test. The Python runtime and the Java port then
  both match scikit-learn to 1e-9.
- **Delivery.** Bundle the model as an asset with a `model_version`, for example
  `shakewalk-lr-2026.10`.
  - Optional: also serve it from `/api/app/config/`, signed, so it can update without a store
    release. Keep the bundled model as the fallback. Never execute downloaded code.
- **Versioning.** The app already sends `ml_model_version` with every sync. The server stores it
  (`StepSyncEvent.ml_model_version`), so shadow results can be split by version.

## 5. Shadow evaluation, then rollout

1. **Run both models side by side.** Ship the new model computing probabilities next to the old
   one. Send them as extra fields (for example `ml2_walk_probability`); the server stores them in
   `raw_payload` and they feed `UserDayFeatures` as new features (feature version f2). Nothing
   uses them for decisions yet.
2. **Compare the two versions** on:
   - disagreement rate
   - shake probability among staff testers doing known-honest walks
   - separation of known cheat labels (admin decisions and payout-hold reviews)
3. **Swap the version.** Only then make the new model the one behind `ml_shake_probability`.
   Server rules keep treating it as one signal among many. The same caution applies as in
   EVALUATION.md: a shaking phone produces step-counter steps whether or not the app is running,
   so the classifier must be paired with coverage. The share of credited steps that had a motion
   window at all should become a first-class feature.

## 6. What this does not solve

- **Scripts and modified APKs.** They can send any probability they like. The classifier only
  helps once its output is bound to the device and app: Play Integrity / App Attest plus a
  server-verified signature over the window summaries. That is Phase 0/2 work.
- **iPhones.** They have no equivalent motion pipeline today. CMPedometer totals only.
- **Motion data only covers part of the day.** It is recorded while the app or walking service
  runs. Most credited steps still arrive without it, so the server-side anomaly model stays
  necessary.
