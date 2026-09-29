# Health Connect permissions declaration (Phase 1c)

> **DRAFT: have a lawyer review; the owner submits it in Play Console > App content >
> Health apps / Health Connect permissions.** Phase 1c is not built yet. This describes the
> intended scope: **read-only** access to **Steps** and **Exercise sessions**. If the
> implementation asks for anything else, update this file and the Privacy Policy first.

## 1. Permissions requested

| Permission | Access | Why |
|---|---|---|
| `android.permission.health.READ_STEPS` | Read | Count the steps recorded by the phone or a paired watch/band (Samsung Health, Fitbit, Mi Fitness, Garmin Connect and others write steps to Health Connect) toward the user's goals and challenges. |
| `android.permission.health.READ_EXERCISE` | Read | Recognise walks and runs recorded by a watch as evidence that steps came from real walking (the "wearable" evidence tier). |

Not requested: any WRITE permission, heart rate, sleep, location/exercise routes, nutrition,
body measurements, medical records, background read (`READ_HEALTH_DATA_IN_BACKGROUND`)
**[confirm: if background read is needed for syncing while the app is closed, declare it
and its justification]**, history read beyond 30 days (`READ_HEALTH_DATA_HISTORY`).

## 2. Declaration answers (Play Console form)

- **App category / core functionality:** fitness: step counting, daily goals and step
  challenges.
- **How does the app use each data type?**
  - Steps: shown to the user as daily and hourly totals; used for goals, streaks, XP, social
    weekly rankings and step challenges (including paid challenges); checked for plausibility.
  - Exercise sessions: start/end time and type (walking, running) used to verify that steps
    during that period were walking; duration shown in the day's breakdown.
- **Is the data shared?** Not shared with third parties. Stored on our server (Render, USA)
  as daily/hourly totals and verification results. Not used for advertising, not sold,
  not used for credit/insurance decisions, not transferred to data brokers.
- **Is data used to train AI/ML?** Aggregated per-day features feed an internal fair-play
  model (shadow only) **[confirm Play's policy allows this for fraud prevention; if unsure,
  exclude Health Connect-sourced fields from `risk_ml` features]**.
- **User control:** users grant access in the Health Connect permission screen, can revoke
  it there at any time, and can delete all their data in Step2Win (Settings › Delete
  account).
- **Privacy policy URL:** [public URL of the published Privacy Policy]. The policy must
  mention Health Connect (section 4.2 of `PRIVACY_POLICY.md` does).

## 3. Implementation requirements (for the Phase 1c engineer)

1. Show an in-app explanation before the Health Connect permission request (reuse
   `ConsentHost` wording style); the user must already have the `health_data` consent.
2. Provide the permissions rationale activity required by Health Connect
   (`ACTION_SHOW_PERMISSIONS_RATIONALE` / `VIEW_PERMISSION_USAGE`) that opens the Privacy
   Policy.
3. Read only what is needed (the challenge window, at most 30 days back) and only the two
   record types above.
4. Keep the data source (`HealthRecord.source` / evidence tier) so the export and the
   per-day explanation show where steps came from.
5. When the user revokes access, stop reading; don't delete already credited history
   unless they delete their account.
