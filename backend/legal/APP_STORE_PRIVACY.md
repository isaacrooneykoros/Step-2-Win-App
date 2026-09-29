# App Store privacy details ("App Privacy" labels)

> **DRAFT: have a lawyer review; the owner fills these in App Store Connect > App
> Privacy.** Same facts as `PLAY_DATA_SAFETY.md`. Apple's definitions: "Linked to the user"
> = tied to the account; "Tracking" = linking with third-party data for ads or sharing with
> data brokers (Step2Win does **no tracking**, so no App Tracking Transparency prompt).

## Data collected

| Apple category | Data type | Linked to user | Used for tracking | Purposes |
|---|---|---|---|---|
| Health & Fitness | **Fitness** (steps, distance, active minutes, motion summaries) | Yes | No | App Functionality, Other Purposes (fraud prevention) |
| Health & Fitness | **Health** (weight, stride length entered by the user) | Yes | No | App Functionality |
| Location | **Precise Location** (only during walks the user starts; optional) | Yes | No | App Functionality, Other Purposes (fraud prevention) |
| Contact Info | Name (optional), Email Address, Phone Number | Yes | No | App Functionality, Developer's Communications (password reset) |
| Financial Info | Payment Info (bank/paybill for withdrawals), Other Financial Info (wallet, payouts) | Yes | No | App Functionality |
| Purchases | Purchase History (challenge entries, deposits) | Yes | No | App Functionality |
| User Content | Photos (profile photo, optional), Other User Content (challenge chat, support messages, team names) | Yes | No | App Functionality |
| Identifiers | User ID, Device ID (device binding, per-install id) | Yes | No | App Functionality, Other Purposes (fraud prevention) |
| Usage Data | Product Interaction (challenges, streaks, social) | Yes | No | App Functionality |
| Diagnostics | Other Diagnostic Data (app/OS version, device model, App Attest result) | Yes | No | App Functionality, Other Purposes |
| Diagnostics | Crash Data | **[confirm]** only if a crash SDK is added | | |

Not collected: Sensitive Info, Contacts, Emails or Text Messages, Audio, Gameplay Content,
Browsing History, Search History, Advertising Data, Credit Info, Coarse Location.

"Other Purposes" (fraud prevention) covers the fair-play checks, account linkage and the
shadow risk model; describe it in the review notes if asked.

## Other App Store items

- **Privacy Policy URL:** public URL of the published policy **[owner]**.
- **Account deletion (5.1.1(v))**: in app (Settings › Delete account) and on the web.
- **Sign in with Apple token revocation** on deletion: still a no-op
  (`revoke_apple_tokens`), must be implemented before Sign in with Apple ships.
- **HealthKit**: not used (CoreMotion only). If HealthKit is added, update the labels and
  add the HealthKit usage strings; HealthKit data may not be used for advertising.
- **Privacy manifest** (`PrivacyInfo.xcprivacy`): `NSPrivacyTracking = false`; declare
  `NSPrivacyCollectedDataTypes` matching the table above and required-reason APIs
  (UserDefaults `CA92.1`).
- **Guideline 5.3** (contests): official rules in the app (Terms + Fair Play Rules).
