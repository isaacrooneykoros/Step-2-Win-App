# Google Play Data safety form: answers for Step2Win

> **DRAFT: have a lawyer review; the owner submits it in Play Console > App content >
> Data safety.** Written from the code at release with Phase 1b (walks, install id, Play
> Integrity, no background location), Phase 2a (account linkage) and Phase 4 (social).
> **Re-check this file whenever a model, a permission or an SDK changes.** This replaces
> the "Data safety form" section of `step2win-web/MOBILE_RELEASE.md` (which predates these
> phases: it mentions background location and IntaSend correctly, but not linkage, walks,
> install id, integrity or social).

## Overview questions

| Question | Answer | Why (code) |
|---|---|---|
| Does your app collect or share any of the required user data types? | **Yes** | |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | HTTPS only; `network_security_config.xml` blocks cleartext in release builds |
| Do you provide a way for users to request that their data is deleted? | **Yes** | In app: Settings › Delete account; web: `https://step-2-win-app.onrender.com/account/delete/` |
| Does the app's data use comply with the Families policy? | Not applicable: not directed at children (18+) | |
| Independent security review | No (optional) | |

"Shared" in Play's sense excludes transfers to service providers processing on our
behalf (Render, IntaSend, Brevo) and transfers the user initiates. We don't share data with
third parties for their own purposes, so every type below is **Collected: yes, Shared: no**.

None of the data is used for advertising or marketing, and none is sold.

## Data types

For each: Collected / Shared / Processed ephemerally / Required or optional / Purposes.
Purposes use Play's list: App functionality, Analytics, Developer communications,
Advertising or marketing, Fraud prevention/security/compliance, Personalization, Account
management.

### Location
| Type | Collected | Shared | Ephemeral | Required? | Purposes | Code |
|---|---|---|---|---|---|---|
| Approximate location | **No** | | | | | `DeviceSession.country` is never filled; network hash is not a location |
| Precise location | **Yes** | No | No | **Optional** (only for walks the user starts) | App functionality, Fraud prevention/security | Phase 1b `WalkSession.raw_points` / `simplified_polyline`; legacy `LocationWaypoint` (deleted after 30 days) |

### Personal info
| Type | Collected | Required? | Purposes | Code |
|---|---|---|---|---|
| Name | Yes | Optional (from Google/Apple sign-in or profile) | App functionality, Account management | `User.first_name/last_name` |
| Email address | Yes | Required | Account management, App functionality, Developer communications (password reset, "data ready") | `User.email` |
| User IDs | Yes | Required | App functionality, Account management, Fraud prevention | username, internal id, Google/Apple subject (`SocialAccount`) |
| Address | No | | | |
| Phone number | Yes | Required | App functionality (M-Pesa), Account management, Fraud prevention (linkage compares payout numbers) | `User.phone_number`, `PaymentTransaction.phone_number`, `WithdrawalRequest.phone_number` |
| Race and ethnicity, Political or religious beliefs, Sexual orientation | No | | | |
| Other info | No | | | |

### Financial info
| Type | Collected | Required? | Purposes | Code |
|---|---|---|---|---|
| User payment info | Yes | Optional (only when withdrawing to a bank / paybill) | App functionality, Fraud prevention/compliance | `WithdrawalRequest.bank_name/account_number/short_code` |
| Purchase history | Yes | Required for paid challenges | App functionality, Fraud prevention/compliance | `WalletTransaction`, `PaymentTransaction`, `Participant`, `HeldPayout` |
| Credit score | No | | | |
| Other financial info | Yes | Required for paid challenges | App functionality, compliance | wallet balance, payouts, withdrawal requests |

### Health and fitness
| Type | Collected | Required? | Purposes | Code |
|---|---|---|---|---|
| Health info | Yes | Optional | App functionality | weight and stride length entered by the user (`User.weight_kg`, `stride_length_cm`) |
| Fitness info | Yes | **Required** | App functionality, Fraud prevention/security | steps, distance, calories, active minutes (`HealthRecord`, `HourlyStepRecord`), motion/gait summaries and walking evidence (`StepSyncEvent.raw_payload`), walk sessions; Phase 1c: Health Connect steps and exercise sessions (read-only) |

### Messages
| Type | Collected | Required? | Purposes | Code |
|---|---|---|---|---|
| Emails | No | | | |
| SMS or MMS | No | | | |
| Other in-app messages | Yes | Optional | App functionality | challenge chat (`ChallengeMessage`), support tickets |

### Photos and videos
| Type | Collected | Required? | Purposes | Code |
|---|---|---|---|---|
| Photos | Yes | Optional | App functionality (profile photo) | `User.profile_picture`. The camera is used only to scan QR invites; scanned images are not uploaded |
| Videos | No | | | |

### Audio files, Files and docs, Calendar, Contacts
Not collected.

### App activity
| Type | Collected | Required? | Purposes | Code |
|---|---|---|---|---|
| App interactions | Yes | Required | App functionality, Fraud prevention | challenge joins, streaks, XP events, sessions |
| In-app search history | No | | | Friend search queries are not stored |
| Installed apps | No | | | |
| Other user-generated content | Yes | Optional | App functionality | team names/descriptions, feed reactions, social reports (Phase 4) |
| Other actions | Yes | Required | Fraud prevention/security | account-linkage evidence (Phase 2a: shared device/number/network, co-location, similar step curves) |

### Web browsing
Not collected.

### App info and performance
| Type | Collected | Required? | Purposes | Code |
|---|---|---|---|---|
| Crash logs | **[confirm]** Yes only if Sentry (`SENTRY_DSN`) is enabled on the server; the Android app has no crash SDK | | App functionality | |
| Diagnostics | Yes | Required | App functionality, Fraud prevention/security | app version, OS version, device model (`DeviceSession`, `DeviceRegistration`), Play Integrity verdicts (Phase 1b) |
| Other app performance data | No | | | |

### Device or other IDs
| Type | Collected | Required? | Purposes | Code |
|---|---|---|---|---|
| Device or other IDs | Yes | Required | Fraud prevention/security, Account management | `User.device_id` / `DeviceRegistration.device_id` (Android ID-based), Phase 1b per-install random id, refresh-token ids. Not the advertising ID |

## Data deletion answers

- "Users can request that their data is deleted": **Yes**.
- Delete account URL: `https://step-2-win-app.onrender.com/account/delete/` (update if the
  API domain changes).
- Some data is kept: **Yes**. Reason to enter: "Wallet transactions, M-Pesa payments,
  withdrawals, payout reviews and challenge results are kept for 7 years, without contact
  details, to meet financial record-keeping and tax obligations. Consent records are kept
  as proof of consent."
- Deleted immediately: name, email, phone (replaced), profile photo, steps and health data,
  walks and location, device and session data, social data, fair-play scores, linkage
  links. See `apps/users/account_deletion.py` and `apps/privacy/erasure.py`.

## Things that would change these answers

- Adding any analytics, crash or ad SDK to the Android app.
- Using approximate location (e.g. filling `DeviceSession.country` from IP).
- Health Connect writing (we only read).
- Sharing any data with a partner for their own use.
- Turning the risk model into a decision-maker (update the Privacy Policy and DPIA too).
