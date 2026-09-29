# Data Protection Impact Assessment (DPIA): Step2Win

> **DRAFT: have a Kenyan data-protection lawyer review this.** KDPA s.31 requires a DPIA
> before processing that is likely to result in a high risk. Step2Win combines several
> high-risk factors: **health data** (sensitive), **precise location**, **money**,
> **profiling / automated decision support**, **matching of data across accounts**
> (linkage), data of a large number of people, and a **transfer to the United States**.
> The ODPC's DPIA guidance note and form should be used for the final version and the DPIA
> may need to be submitted to the ODPC before launch **[confirm]**.

| | |
|---|---|
| Controller | [entity], [address] |
| DPO | [name, contact] |
| Prepared by / date | Engineering (draft), 2026-09-30 |
| Reviewed by | [lawyer], [date] |
| Next review | Before any of: the risk model is used for decisions; a new data source (Health Connect, iOS); a new processor; or 12 months |

## 1. Description of the processing

Step2Win counts users' steps, runs goals, streaks, social rankings and paid challenges with
M-Pesa entry fees and payouts. The data inventory (`DATA_INVENTORY.md`) lists every
field. Main flows:

1. **Step counting:** the phone's step sensor (Android foreground service type `health`;
   iOS CoreMotion) and, later, Health Connect (read-only) produce steps. The app uploads
   daily/hourly totals and motion summaries (cadence, gait confidence, carry mode, burst
   counts, per-minute walking evidence) to the API in signed sessions bound to one device.
2. **Verification:** server rules (velocity, gait evidence tiers, integrity verdicts,
   vehicle detection) decide how many steps count toward challenge money. A per-day
   explanation is stored and shown to the user.
3. **Walk sessions:** the user starts a walk; GPS is recorded in the foreground only while
   it runs; raw points are deleted after 30 days, a simplified route is kept.
4. **Payout holds:** at settlement, rule-based checks hold a payout; a staff member decides
   (release / forfeit) within 48 hours.
5. **Account linkage:** nightly, the system compares accounts for shared devices, M-Pesa or
   payout numbers, home networks (keyed hash of the /24), co-location of walks, near
   identical hourly step curves, joint challenge behaviour and step handovers. Strong or
   combined evidence links accounts; linked accounts' payouts in the same challenge are held
   for review. Staff see masked evidence.
6. **Shadow risk model:** nightly features (~70 per user-day) and an anomaly score with
   plain-English reasons, stored for 12 months, **not used for any decision**.
7. **Payments** via IntaSend (M-Pesa, banks).
8. **Social:** friends, teams, weekly rankings, feed of milestones (no locations or money).
9. **Hosting:** Render, United States.

## 2. Necessity and proportionality

| Question | Answer |
|---|---|
| Purpose legitimate and specific? | Yes: run the service; prevent fraud that would take money from honest users. |
| Is each data item needed? | Steps and motion summaries: yes (core and fraud). Raw sensor streams: **not uploaded**. Location: only for user-started walks, optional. Full IPs: only while a session is active. Phone numbers in linkage: compared server-side, shown masked. |
| Less intrusive alternatives considered? | Background location was removed in Phase 1b. The risk model stays shadow-only. Linkage uses keyed hashes and masked identifiers. Money-only enforcement ("hold money, not people") limits the impact of false positives. |
| Data minimisation in storage | Retention jobs: sync payloads trimmed at 90 days; walk raw points 30 days; legacy waypoints 30 days; risk features/scores 12 months; login logs and reset codes 30 days; network hash 90 days. |
| Lawful basis | Contract; explicit consent for health data (s.44/45) and location; legitimate interest for fraud prevention (balancing test in §5); legal obligation for financial records. |
| Transparency | Privacy Policy (plain English), in-app consents at registration and before the first walk, per-day "How were my steps counted?", Fair Play Rules, Settings › Privacy & your data. |
| Rights | Export (ZIP, JSON), correction, deletion (app + web), consent withdrawal, human review of holds, appeals. |
| Processors | Render, IntaSend, Brevo, Google, Apple, Cloudflare, Vercel (see inventory). DPAs to be signed/confirmed. |
| International transfer | Render (USA). Safeguards: DPA/SCCs, TLS, encryption at rest, access controls. Transfer must be documented for the ODPC (s.49). |

## 3. Risks to individuals

Likelihood (L) and severity (S): 1 low, 2 medium, 3 high. Residual risk after measures.

| # | Risk | L | S | Measures in place | Residual |
|---|---|---|---|---|---|
| R1 | **False accusation of cheating**: an honest user (runner at 180+ spm, wheelchair user, treadmill, budget phone with noisy sensors, matatu commuter) has steps discounted or a payout held | 2 | 2 | Money-only effect; goals/streaks/XP never reduced; holds reviewed by staff within 48 h; neutral wording; per-day explanation; appeals; strong-evidence-only exclusion; tests for these user types (ANTICHEAT.md) | Medium: monitor hold rate and appeal outcomes |
| R2 | **Solely automated decisions with significant effect** (KDPA s.35) | 2 | 2 | A human decides every held payout; automated trust deductions never suspend; the risk model is shadow only; human review on request | Low-medium **[lawyer: confirm step-credit reduction is not a "significant effect" or document s.35(2) basis]** |
| R3 | **Location tracking reveals home, routines, or is seen by others** | 2 | 3 | Foreground only, user-started walks, optional consent, raw points deleted after 30 days, home privacy zone stored as hashes, routes never shown to other users, social feed never shows location | Low |
| R4 | **Linkage exposes relationships** (family, housemates, partners sharing a phone or M-Pesa) to staff | 2 | 2 | Masked identifiers (last 3 digits), keyed network hashes, household marks, public-place thresholds (network/co-location seen by many accounts ignored), staff access controls, deleted with the account | Low-medium |
| R5 | **Health data breach** (steps, motion, weight) | 1 | 2 | TLS, hashed passwords, no raw sensor data uploaded, staff access logs, retention, incident plan (72 h) | Low |
| R6 | **Financial data breach** (M-Pesa numbers, bank details) | 1 | 3 | IntaSend handles payment credentials; we store phone and bank account numbers only; access limited to finance staff; audit log | Medium: consider encrypting bank account numbers at rest |
| R7 | **Transfer to the US**: foreign authority access, weaker remedies | 2 | 2 | DPA/SCCs, encryption, minimisation, documented transfer | Medium **[lawyer]** |
| R8 | **Function creep of the risk model** into automated decisions | 1 | 3 | Shadow only; any change requires a DPIA update, Privacy Policy update and human-in-the-loop design | Low |
| R9 | **Minors** using a real-money app | 2 | 3 | 18+ confirmation at registration; closure on discovery. No age verification beyond self-declaration **[lawyer: sufficient?]** | Medium |
| R10 | **Over-retention of money records with PII** after deletion | 2 | 1 | Contact details anonymised on deletion; phone numbers remain on payment/withdrawal rows for 7 years (legal) | Low-medium |
| R11 | **Social exposure** (being found or ranked against one's will) | 2 | 1 | Discoverability setting, sharing toggles, blocks, reports, no money/location in the feed | Low |
| R12 | **Consent not freely given** because health data is required for the service | 2 | 2 | Explained clearly; optional uses separated (location); withdrawal = account deletion **[lawyer: confirm consent vs contract basis for health data]** | Medium |
| R13 | **Device identifiers and install IDs used for tracking** | 1 | 1 | Used only for fraud and session binding, never for ads, no third-party SDKs | Low |

## 4. Measures summary

- Privacy by design: foreground-only location, masked staff views, keyed hashes, no raw
  sensor uploads, shadow-only model, deletion cascade across apps (users, risk_ml, linkage,
  social, privacy).
- Retention automation (`apps/privacy/retention.py`, Phase 1b walk purge, Phase 2a IP purge).
- Rights tooling (`/api/privacy/*`, Settings › Privacy & your data, `/account/delete/`).
- Consent ledger with versions and re-consent on material policy changes.
- Staff training and access control **[to do: written access policy, least privilege for
  finance vs fair-play staff, MFA for staff accounts]**.
- Incident response plan (`INCIDENT_RESPONSE.md`).

## 5. Legitimate-interest balancing (fraud prevention and linkage)

- **Interest:** protect the prize pool and honest users; comply with AML expectations.
- **Necessity:** without server-side checks, scripted or multi-account play would drain
  pools (the anti-cheat audit showed this is realistic).
- **Balance:** effects are limited to money eligibility with human review; data is
  minimised and masked; users are told in the Privacy Policy and Fair Play Rules; users can
  object and appeal. Users of a real-money contest reasonably expect fairness checks.
- **Conclusion (draft):** legitimate interest is appropriate for fraud checks and linkage;
  consent is used for health data and location.

## 6. Open questions for the lawyer

1. Health data basis: explicit consent (with withdrawal = leaving) vs. contract; is
   bundling health consent with account creation acceptable?
2. Does reducing challenge-eligible steps count as a decision "which produces legal effects
   or significantly affects" the user (s.35)? Is human review of payout holds sufficient?
3. Must the access request include anti-cheat assessments (fraud flags, linkage evidence,
   risk scores) in full? Our export gives counts and dates only, citing fraud prevention;
   is an exemption available (s.51/s.52) and how should it be documented?
4. Transfer mechanism to Render (USA): which s.48/49 basis; does the ODPC need prior
   notification or proof of safeguards?
5. Retention: 7 years for financial records (Tax Procedures Act s.23 says 5 years; AML
   rules may say 7); consent records; support tickets; staff audit logs.
6. Is a paid step challenge a "game of skill" or betting under the Betting, Lotteries and
   Gaming Act / the Gambling Control Act 2025? Licences needed?
7. Age verification: is self-declaration enough for a real-money product?
8. Is a DPIA submission to the ODPC required before launch?

## 7. Sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| DPO | | | |
| Owner | | | |
| Legal counsel | | | |
