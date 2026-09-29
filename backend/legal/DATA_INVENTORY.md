# Step2Win data inventory (record of processing)

> **DRAFT: have a Kenyan data-protection lawyer review this.** Written from the code on
> 2026-09-30 (main at e755b0f, plus the branches for Phase 1b walks, Phase 2a account
> linkage and Phase 4 social, which are due to merge). It is not legal advice. Items
> marked **[confirm]** need a decision from the owner, an accountant or a lawyer.

This is the "record of processing" the Kenya Data Protection Act 2019 (KDPA) and the Data
Protection (General) Regulations 2021 expect a controller to keep. It also feeds the
Privacy Policy, the DPIA, the Google Play Data safety form and the App Store privacy
labels. When a model or a client collection changes, update this file first.

## 1. Who and where

| Item | Value |
|---|---|
| Controller | Step2Win (legal entity name, registration number and address **[confirm]**) |
| Data Protection Officer / privacy contact | **[confirm]** name, email (e.g. privacy@step2win.app), phone |
| Users | Adults (18+) in Kenya. Real-money challenges, so no children. |
| Customer app | Android app (Capacitor), iOS app later; web build on Cloudflare Pages |
| API and database | Django on Render, **United States** region (PostgreSQL + Redis on Render) |
| Staff console | React app on Vercel; staff sign in to the same API |

### Processors and other recipients

| Recipient | Role | What they get | Where | Safeguard / note |
|---|---|---|---|---|
| Render (Render Services, Inc.) | Hosting: API, PostgreSQL, Redis | Everything in this inventory (stored and processed) | USA | Cross-border transfer (KDPA s.48-50). Render DPA + SCC-style terms, encryption in transit (TLS) and at rest (Render-managed) **[confirm DPA signed; confirm region]** |
| Cloudflare (Pages) | Serves the customer web build | Visitor IP and request logs | Global CDN | No app data stored there |
| Vercel | Serves the staff console | Staff IP and request logs | Global CDN / USA | Staff only |
| IntaSend (Intasend Solutions Ltd) | Payment service provider: M-Pesa collections and payouts, bank/paybill payouts | Phone number, amount, narration, name for payouts, bank/paybill details for withdrawals | Kenya | Processor agreement **[confirm]**; licensed by CBK **[confirm]** |
| Safaricom (M-Pesa) | Mobile money network, via IntaSend | Phone number, amount | Kenya | Independent controller for M-Pesa |
| PochPay | Legacy payment client still in the code (`apps/payments/pochipay.py`) | None if unused | Kenya | **[confirm unused; remove the client if so]** |
| Brevo (or another SMTP provider, `EMAIL_HOST`) | Transactional email: password-reset codes, "your data is ready" | Email address, message text | EU (France) for Brevo | DPA with Brevo **[confirm provider]** |
| Google | Sign in with Google (ID token verification), Google Play (distribution), Play Integrity API (Phase 1b), Health Connect (Phase 1c, on device) | Google sign-in: Google already holds the account; we receive name, email, Google user id. Play Integrity: a request nonce and the device verdict | USA / global | Google terms; Play Integrity only in the app |
| Apple | Sign in with Apple (when enabled), App Store, CoreMotion on device | Apple user id, email (possibly relay) | USA / global | Apple terms |
| OpenStreetMap Foundation tile servers | Map tiles on the legacy day-route map (`StepsDayMap.tsx`) | Device IP and the map area being viewed | UK / EU | **Consider a commercial tile provider or removing the map; OSM tile policy discourages app use** |
| Sentry (only if `SENTRY_DSN` is set) | Error monitoring | Stack traces; `send_default_pii` is off, so no user fields by default | USA | **[confirm whether enabled]** |
| GitHub (Actions) | Calls the scheduled-jobs endpoint every 10 min; CI | A shared token; no personal data | USA | |

Nothing is sold, and nothing is shared for advertising. There are no analytics or ad SDKs in
the apps (checked `step2win-web/src`, `index.html` and the Android manifest).

## 2. Categories

Retention default values are admin settings (`PrivacySettings`, staff API
`/api/privacy/admin/settings/` or Django admin) unless marked "code".

Lawful bases used below (KDPA s.30): **Contract** (s.30(1)(b)(i), needed to provide the
service the user signed up for), **Legal obligation** (s.30(1)(b)(ii)), **Legitimate interest**
(s.30(1)(b)(vi), fraud prevention and security; balanced in the DPIA), **Consent**
(s.30(1)(a), and explicit consent for health data under s.44/s.45).

### 2.1 Account and identity

| Storage | Fields | Purpose | Basis | Access | Retention |
|---|---|---|---|---|---|
| `users.User` | username, email, phone_number (the M-Pesa number, unique), first/last name, password hash, date_joined, last_login, profile_picture (file in `media/profile_pictures/`), daily_goal, device_platform | Run the account, sign-in, payments | Contract | User; staff (User drawer) | While the account is open. On deletion: anonymised (`deleted_<id>`), photo file removed (`apps/users/account_deletion.py`, `apps/privacy/erasure.py`) |
| `users.User` body data | stride_length_cm, weight_kg, calibration_quality/variance, last_calibrated_at | Distance and calorie estimates | Consent (health data) | User | While open; reset to defaults on deletion (`apps/privacy/erasure.py`) |
| `users.SocialAccount` | provider, subject (Google/Apple user id), email, created/last login | Sign in with Google / Apple | Contract | Staff | Deleted on account deletion |
| `users.PasswordResetCode` | code hash, reset-token hash, attempts, **request_ip** | Forgot-password flow | Contract, security | None (hashes) | Rows deleted after **30 days** (`privacy-retention`); deleted on account deletion |
| `legal.UserDocumentAck` | document, version seen | Show "policy updated" | Legal obligation | Staff | Kept with the (anonymised) account |
| `privacy.Consent` | purpose, granted, version, document_versions, text_version, source, app_version, time | Proof of consent (KDPA s.32) | Legal obligation | Staff (read-only Django admin) | Kept for the life of the processing + **[confirm]** (suggest 7 years after account deletion); not deleted on account deletion (no contact details) |

### 2.2 Activity and health data (sensitive: "health data", KDPA s.2 / s.44)

| Storage | Fields | Purpose | Basis | Access | Retention |
|---|---|---|---|---|---|
| `steps.HealthRecord` | per day: steps, distance_km, calories_active, active_minutes, source, last_raw_steps, unverified_steps, `verification` (user-facing breakdown), `anticheat` (internal JSON: suspicion, contributing syncs, gait coverage), is_suspicious; Phase 1b: eligible_steps and tier_* columns | Goals, streaks, challenges, fair play | Explicit consent (`health_data`) + contract | User (own history); staff | While the account is open (history and challenge integrity). Deleted on account deletion |
| `steps.HourlyStepRecord` | per hour: steps, distance, calories | Charts, velocity checks | Consent + contract | User; staff | While open; deleted on deletion |
| `steps.StepSyncEvent` | per upload: timestamps, steps delta/total, ML motion label and probabilities, accepted/rejection reason, `raw_payload` (the request body: gait features such as cadence, gait confidence, autocorrelation, carry mode, burst counts; Phase 1b adds install id, time zone, per-minute walking evidence; session token redacted) | Fair play, replay protection | Consent + legitimate interest | Staff | `raw_payload` trimmed to aggregate fields after **90 days** (`privacy-retention`, `KEEP_PAYLOAD_KEYS`); skipped while the session is under an open review. Rows deleted on account deletion. **[decide]** a cap for the trimmed rows (suggest 2 years) |
| `steps.IntervalVerificationResult` | per interval: raw/normalised/verified steps, risk and confidence scores, rule hits, explainability | Anti-cheat v2 (shadow/active) | Legitimate interest | Staff | Deleted after **12 months** (`privacy-retention`); deleted on account deletion |
| `steps.DailyVerificationSummary` | per day aggregates, audit snapshot | Anti-cheat v2 | Legitimate interest | Staff | While open **[decide: suggest 24 months]**; deleted on account deletion |
| `steps.StepSession` | session token hash, nonce, status, totals, averaged ML probabilities, risk score; Phase 1b: integrity_status/verdict (Play Integrity / App Attest), tz offset/name, install_id | Signed step sessions, device integrity | Legitimate interest | Staff | Deleted on account deletion unless under an anti-cheat review **[decide a cap]** |
| `steps.SuspiciousActivity`, `steps.SuspiciousSessionReview`, `steps.FraudFlag` | flag type, severity, date, details JSON, review state, reviewer | Fair-play review | Legitimate interest | Staff | Reviewed `SuspiciousActivity` deleted after 90 days (existing job). Flags and reviews kept with the anonymised account as integrity records **[decide: suggest 24 months after the related challenge, longer if a payout decision relies on them]** |
| `steps.TrustScore`, `steps.UserTrustProfile` | score, flags, admin status/lock | Fair play, payout holds | Legitimate interest | User sees own score/status; staff | While open; kept with the anonymised account |
| Phase 1b `steps.WalkSession` (user-started walks) | start/end, local date, tz offset, steps, verified steps, gait counts, distance, speeds, vehicle seconds/hours, mock-location flag, **raw GPS points**, simplified encoded polyline, integrity nonce/verdict, install id | Walk evidence for challenge money | Consent (`location_walks`) + contract | User (own walks); staff | Raw points deleted after **30 days** (Phase 1b job `purge-old-walk-points`, `WALK_RAW_POINTS_RETENTION_DAYS`); the simplified route kept while the account is open; walks deleted on account deletion |
| Phase 1b `steps.WalkPrivacyZone` | salt, geohash precision, radius, **hashes** of cells (no coordinates) | Hide route ends near home | Consent | User | Until the user removes it; deleted on account deletion |
| `steps.LocationWaypoint` (legacy background route points) | date, hour, time, lat/long, accuracy | Old day-route map | Consent | User; staff | Deleted after **30 days** (`privacy-retention`); background location is removed in Phase 1b |
| On device only | Android step ledger / evidence ledger (SQLite / SharedPreferences), sensor windows, raw accelerometer data | Counting and classifying steps | Consent | Device | Never uploaded raw; only the aggregates above |
| Phase 1c Health Connect (planned) | Steps and exercise sessions, **read only** | Credit steps from phones/watches that write to Health Connect | Consent (OS permission + `health_data`) | User | Stored as `HealthRecord` / walk evidence as above; nothing written back |

### 2.3 Location

Covered above: Phase 1b walk routes (foreground only, only while a walk the user started
is running, foreground service type `location` while the walk runs) and legacy waypoints.
The Phase 2a co-location detector compares different users' routes to find accounts
walking together; it stores only counts and dates as evidence (no coordinates).
Coarse country (`DeviceSession.country`) comes from the sign-in request.

### 2.4 Financial

| Storage | Fields | Purpose | Basis | Access | Retention |
|---|---|---|---|---|---|
| `users.User` | wallet_balance, locked_balance, total_earned | Wallet | Contract | User; staff | While open |
| `wallet.WalletTransaction` | type, amount, balances, description, reference, metadata | Ledger | Contract; legal obligation (accounting, tax) | User (own); staff | **7 years** after the transaction **[confirm with accountant: Tax Procedures Act s.23 keeps records 5 years; many firms use 7]**; kept after account deletion, linked to the anonymised user |
| `payments.PaymentTransaction` | type, status, amount, IntaSend/M-Pesa references, **phone_number**, narration, callback time | Deposits, payouts | Contract; legal obligation | User (own); staff | 7 years **[confirm]**; kept after deletion |
| `payments.WithdrawalRequest` | amount, method, **phone_number, bank name, account number, paybill/till**, status, references, reviewer, rejection reason | Withdrawals | Contract; legal obligation; AML **[confirm obligations]** | User (own); staff | 7 years **[confirm]** |
| `wallet.Withdrawal` (legacy) | amount, account_details, status, notes | Old withdrawals | Legal obligation | Staff | 7 years **[confirm]** |
| `payments.CallbackLog` | raw IntaSend callback payload (may include phone and name) | Reconciliation, idempotency | Legal obligation | Staff | 7 years **[confirm; consider masking phone after 90 days]** |
| `payments.PlatformRevenue` | amount, challenge, narration | Accounting | Legal obligation | Staff | 7 years |
| `challenges.Participant`, `challenges.ChallengeResult` | steps, qualified, rank, payout, tiebreak stats | Challenges and payouts | Contract | Challenge members see names/steps; staff | 7 years (they justify payouts) |
| `challenges.HeldPayout` (Phase 1a) | amount, reasons (rule codes and details), status, staff decision, note, resolution (who received the forfeit) | Payout review | Contract; legitimate interest | User sees "under review"; staff | 7 years **[confirm]**; kept after deletion |

### 2.5 Devices and network

| Storage | Fields | Purpose | Basis | Access | Retention |
|---|---|---|---|---|---|
| `users.User.device_id` | the bound device id (Android ID-based) | One active device per account | Legitimate interest (fraud) | Staff | Cleared on deletion |
| `steps.DeviceRegistration` | device_id, public key, platform, app version, trust level, first/last seen | Device binding, signatures | Legitimate interest | Staff | Deleted on account deletion **[decide cap for old devices]** |
| `users.DeviceSession` | refresh-token id, device type/name/OS, app version, **ip_address**, country, active, last active; Phase 2a: `network_hash` (keyed HMAC of the /24 network) | Active sessions screen, security, linkage | Contract; legitimate interest | User (own sessions); staff see a **masked** IP | Phase 2a: full IP cleared when the session ends and after 90 days at the latest; network hash deleted after **90 days** (`privacy-ip-retention`). Inactive sessions deleted after 30 days (`cleanup-inactive-sessions`). All deleted on account deletion (`apps/privacy/erasure.py`) |
| Phase 1b install id | random UUID per app install, sent with syncs, sessions and walks | Detect reinstalls / multiple installs | Legitimate interest | Staff | Lives in the sync payload (trimmed at 90 days) and on sessions/walks |
| Play Integrity / App Attest verdicts (Phase 1b) | verdict JSON, status, time | Detect rooted/emulated/modified apps | Legitimate interest | Staff | With the session/walk |
| django-axes `AccessAttempt` / `AccessLog` / `AccessFailureLog` | username tried, IP, user agent, time | Brute-force protection | Legitimate interest | Staff (Django admin) | Deleted after **30 days** (`privacy-retention`); deleted for the account on deletion |
| django-auditlog `LogEntry` | changes to user/wallet/payment rows, actor, **remote_addr** | Audit trail | Legal obligation; legitimate interest | Staff | Kept **[decide: suggest 7 years for money rows]**; on deletion the user's email/username/subject are redacted and the IPs they caused are cleared |
| `admin_api.AuditLog` | staff action, target, description, staff IP and user agent | Staff accountability | Legitimate interest | Staff (superusers) | Kept **[decide: suggest 7 years]**; the deleted user's old identifiers are replaced in the text |

### 2.6 Anti-cheat scores and profiling

| Storage | Fields | Purpose | Basis | Access | Retention |
|---|---|---|---|---|---|
| `risk_ml.UserDayFeatures` | ~70 derived features per user-day (no coordinates, no phone numbers) | Shadow risk model | Legitimate interest | Staff | Deleted after **12 months** (`privacy-retention`); deleted on account deletion (`risk_ml/signals.py`) |
| `risk_ml.RiskScore` | score 0-1, plain-English explanations, context | Shadow risk model (no decisions) | Legitimate interest | Staff | 12 months; deleted on deletion |
| `risk_ml.Label` | human label on a user-day window, source, notes | Training data | Legitimate interest | Staff | Kept with the decision it records; notes scrubbed on deletion **[decide cap: suggest 24 months]** |
| `risk_ml.ModelArtifact` | model parameters and model card | Model | n/a (no personal data) | Staff | Indefinite |

Automated decisions: rules can reduce challenge-eligible steps and hold a payout; a human
decides every held payout (release or forfeit) within 48 hours. The risk model is shadow
only. See the DPIA.

### 2.7 Account linkage (Phase 2a)

| Storage | Fields | Purpose | Basis | Access | Retention |
|---|---|---|---|---|---|
| `linkage.LinkEdge` | two user ids, evidence type (same phone, same payout/deposit number, near-sequential numbers, same home network, walked at the same place and time, near-identical hourly steps, joint challenges, handover), strength, weight, evidence JSON with **masked** identifiers (last 3 digits), keyed hashes, counts, dates | Detect multi-account farms and collusion before paying out | Legitimate interest | Staff (masked) | Recomputed nightly; inactive when the evidence stops; deleted when either account is deleted (`linkage/signals.py`). **[decide cap for inactive edges: suggest 12 months]** |
| `linkage.LinkCluster`, `LinkClusterMember` | groups of linked accounts | Same | Legitimate interest | Staff | Rebuilt nightly |
| `linkage.HouseholdMark` | staff note that two accounts are a real household | Avoid false holds | Legitimate interest | Staff | Deleted when either account is deleted |
| `linkage.LinkageSettings`, `LinkageRun` | policy switches, run stats | Operations | n/a | Staff | Indefinite |

### 2.8 Social (Phase 4)

| Storage | Fields | Purpose | Basis | Access | Retention |
|---|---|---|---|---|---|
| `social.SocialProfile` | friend code, discoverability, sharing switches, notification switches | Friends and privacy choices | Contract | User | Deleted on account deletion (`social/deletion.py`) |
| `FriendRequest`, `Friendship`, `Block` | who, status, when | Friends | Contract | The two users; staff | Deleted on deletion (both directions) |
| `Team`, `TeamMembership` | team name, description, invite code, role | Teams | Contract | Members; public teams visible to all | Membership deleted on deletion; ownership passes on |
| `WeeklyStepTotal`, `TeamWeeklyTotal`, `WeeklyArchive` | weekly steps, ranks | Rankings (no money) | Contract | Friends/team members | Deleted on deletion **[decide cap: suggest 2 years]** |
| `FeedEvent`, `FeedReaction`, `SocialNotification` | milestones (goal hit, streak, badge, qualified), reactions | Activity feed | Contract | Friends | Deleted on deletion **[decide cap: suggest 12 months]** |
| `SocialReport` | reporter, target, reason, details, review | Moderation | Legitimate interest | Staff | Kept; reporter link removed on the reporter's deletion |

### 2.9 Messages, support and gamification

| Storage | Fields | Purpose | Basis | Access | Retention |
|---|---|---|---|---|---|
| `challenges.ChallengeMessage` | challenge chat text, author | Challenge chat | Contract | Challenge members; staff | Kept with the anonymised author **[gap: see §4]** |
| `admin_api.SupportTicket`, `SupportTicketMessage` | subject, message, category, status, staff notes, tags | Support | Contract | User (own); staff | Kept; the user's sender name anonymised on deletion **[decide: suggest 3 years after closure]** |
| `gamification.*` (UserXP, XPEvent, UserBadge, LevelMilestone, DailyLoginStreak) | XP, badges, levels, login streak | Rewards | Contract | User | Kept with the anonymised account |
| `privacy.DataExportRequest` | status, times, size, SHA-256, the ZIP (in the database) | Right of access | Legal obligation | The user (download); staff see status only | ZIP deleted when the download expires (**72 hours**); rows deleted after 1 year; all deleted on account deletion |

## 3. Data subject rights: where they are implemented

| Right (KDPA s.26) | Where |
|---|---|
| Be informed | Privacy Policy (`backend/legal/PRIVACY_POLICY.md`, published via Admin > Legal documents); in-app notices (registration, walk location prompt) |
| Access / portability | Settings > Privacy & your data > Download a copy (`POST /api/privacy/exports/`, built by the `privacy-process-exports` job, one per 24 h, link valid 72 h) |
| Rectification | Settings > Personal details (profile endpoints); support ticket for anything else |
| Erasure | Settings > Delete account (in app) and `/account/delete/` (web); `apps/users/account_deletion.py` + `apps/privacy/erasure.py` |
| Object / withdraw consent | Settings > Privacy & your data (optional consents); required ones by deleting the account |
| Not to be subject to solely automated decisions | Payout holds are reviewed by staff; appeal through support (Fair play rules) |

## 4. Known gaps and follow-ups (for the lead / owner)

1. **Challenge chat messages** keep their text after the author deletes the account (author
   shown as `deleted_<id>`). Decide: blank the text on deletion, or keep for the other
   members' conversation. (Owned by `apps/challenges`.)
2. **Support tickets** keep the user's own text; decide a retention period (suggest 3 years
   after closure) and add a job. (Owned by `apps/admin_api`.)
3. **Account deletion with a held payout**: `get_blockers` does not block deletion while a
   `HeldPayout` is `held`; the payout then becomes forfeit-only. Suggest adding a blocker
   ("a payout is under review") in `apps/users/account_deletion.py`. (Owned by users/payouts.)
4. **Location consent at walk start is not enforced on the server** yet: the Phase 1b walk
   start view should refuse with `403 LOCATION_CONSENT_REQUIRED` unless
   `apps.privacy.consent.has_consent(user, "location_walks")`. See `backend/legal/README.md`.
5. `CallbackLog.raw_payload` keeps phone numbers for 7 years; consider masking after 90 days.
6. `StepSession` / `DeviceRegistration` / `DailyVerificationSummary` / trimmed sync rows have
   no age cap yet (suggested caps above).
7. OpenStreetMap tiles on the legacy map (see §1).
8. The Android manifest on `main` still declares `ACCESS_BACKGROUND_LOCATION`; Phase 1b
   removes it. Do not ship a build with it.
