# ODPC registration and compliance checklist (Kenya)

> **DRAFT: have a Kenyan data-protection lawyer review this.** Items marked **[verify]**
> could not be verified from the code or were checked only from general knowledge of the
> Data Protection Act 2019 (KDPA) and the Data Protection (Registration of Data
> Controllers and Data Processors) Regulations 2021. Fees and thresholds change: confirm on
> www.odpc.go.ke before filing.

## A. Registration with the Office of the Data Protection Commissioner

| # | Item | Status | Notes |
|---|---|---|---|
| A1 | Is registration mandatory for Step2Win? | **[verify]** likely **yes** | Mandatory regardless of size for processing of **health data** and for some sectors; Step2Win processes health data and runs financial transactions. |
| A2 | Register as **data controller** on the ODPC e-portal (odpc.go.ke > Registration) | To do | Needs the legal entity's details, KRA PIN, business registration certificate. |
| A3 | Registration fee and category (micro/small/medium/large by turnover and staff) | **[verify]** | Fee depends on category; certificate valid 24 months **[verify]**, renew before expiry. |
| A4 | Description of processing: purposes, categories of data subjects and data, recipients, transfers, safeguards | Draft ready | Use `DATA_INVENTORY.md` §1-2. |
| A5 | Declare **cross-border transfer** to the United States (Render) and the EU (Brevo) and the safeguards | To do | KDPA s.48-50; Regulations on transfers. Attach Render/Brevo DPAs. |
| A6 | Declare **sensitive personal data** (health data) and the lawful basis | To do | KDPA s.44-46. |
| A7 | Do processors need their own ODPC registration? (IntaSend is Kenyan) | **[verify]** | Ask IntaSend for its ODPC certificate; add to vendor file. |
| A8 | Display the registration certificate number in the Privacy Policy | After A2 | Placeholder in `PRIVACY_POLICY.md` §1. |
| A9 | Notify the ODPC of changes to the registered particulars | Ongoing | e.g. new processor, new purpose (risk model going live). **[verify deadline]** |

## B. Governance

| # | Item | Status | Notes |
|---|---|---|---|
| B1 | Appoint a **Data Protection Officer** (KDPA s.24): required where core activities involve regular and systematic monitoring or large-scale sensitive data | **[verify]** likely required | Anti-cheat monitoring + health data. Can be an employee or a contractor; publish contact details. |
| B2 | Record of processing | Draft | `DATA_INVENTORY.md`. |
| B3 | **DPIA** (KDPA s.31) | Draft | `DPIA_DRAFT.md`; confirm whether it must be filed with the ODPC before launch **[verify]**. |
| B4 | Privacy Policy published in the app | Draft | Seeded as a DRAFT in Admin > Legal documents (never auto-published). |
| B5 | Data processing agreements with Render, IntaSend, Brevo, Google/Apple terms | To do | KDPA s.42. |
| B6 | Staff confidentiality and access policy; MFA on staff accounts | To do | Staff console access is role-based (is_staff / superuser). |
| B7 | Breach response plan and register | Draft | `INCIDENT_RESPONSE.md`; 72 hours to notify the ODPC (s.43). |
| B8 | Data subject request procedure and log | Implemented in app | Export (`/api/privacy/exports/`), deletion, consent changes. Keep a manual log for email requests. |
| B9 | Retention schedule | Implemented (partly) | `apps/privacy/retention.py`; open items in `DATA_INVENTORY.md` §4. |
| B10 | Children: 18+ only | Implemented | Registration checkbox; no age verification **[lawyer]**. |
| B11 | Annual review of this checklist, DPIA and inventory | To do | |

## C. Consent and transparency (implemented in code)

- Registration requires two unticked boxes: Terms + Privacy Policy + "18 or older", and
  activity/health data (`apps/privacy/consent.py`, `RegisterScreen.tsx`).
- Google/Apple sign-ups and existing users see a blocking consent screen until they accept
  (`ConsentHost.tsx`).
- Location consent before the first walk (API ready; wiring at the Phase 1b merge).
- Re-consent when a document is published with "notify users" on.
- Consent ledger kept as evidence (`privacy.Consent`, read-only in Django admin).

## D. Other Kenyan requirements to check (not data protection)

| Item | Status |
|---|---|
| Gaming/betting licence for paid challenges (BCLB / Gambling Control Act 2025) | **[verify with lawyer]** |
| Payment services: IntaSend as licensed PSP; any CBK requirements for holding wallet balances | **[verify]** |
| Tax: KRA registration, eTIMS invoices for platform fees, withholding tax on winnings | **[verify with accountant]** |
| AML/CFT obligations (Proceeds of Crime and Anti-Money Laundering Act) | **[verify]** |
| Consumer Protection Act: clear terms, refund policy | Terms + Fair Play Rules drafted |
