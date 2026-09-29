# Step2Win Privacy Policy

> **DRAFT: have a Kenyan data-protection lawyer review this before publishing.** Items in
> [square brackets] must be filled in by the owner. Source of truth for the facts:
> `backend/legal/DATA_INVENTORY.md`. When published through Admin > Legal documents with
> "notify users" on, every user is asked to accept the new version.

**Version:** [x.y] · **Effective:** [date] · **Last updated:** [date]

## 1. Who we are

Step2Win is a step-challenge app: you count your steps, reach goals, join challenges with
friends and, in paid challenges, can earn money through M-Pesa. Step2Win is operated by
[legal entity name], [registration number], [physical address], Kenya ("Step2Win", "we").

We are the **data controller** for your personal data and are registered with the Office
of the Data Protection Commissioner (ODPC) under registration number [number].

**Contact our Data Protection Officer:** [name], [privacy@step2win.app], [phone], [postal
address]. You can also write to us from the app: Settings › Help & support.

## 2. Who can use Step2Win

Step2Win is for people **18 years or older**. Paid challenges involve real money, so we
don't allow children to have an account. If we learn that an account belongs to someone
under 18, we close it and delete its data (keeping only the money records the law
requires).

## 3. The short version

- We use your steps and your phone's motion data to count steps, run challenges and keep
  them fair. This is health data, so we ask for your explicit consent.
- We use your location **only while a walk you started is running**, and only if you allow
  it. Never in the background.
- We check for cheating before paying money out. Automated checks can **hold** a payout for
  a person to review (normally within 48 hours); they never close your account on their own.
- We keep money records for 7 years, as the law requires. Everything else is deleted or
  reduced on a schedule (section 9).
- Our servers are in the **United States** (section 8).
- We don't sell your data, we don't show ads and we don't use advertising trackers.
- You can see, download, correct and delete your data from the app (section 10).

## 4. What we collect and why

### 4.1 Account details
Username, email, M-Pesa phone number, password (stored only as a secure hash), optional
name and profile photo, your daily goal. If you sign in with Google or Apple we receive your
name, email and an account ID from them.
*Why:* to create and run your account and pay you. *Legal basis:* contract.

### 4.2 Activity and health data
- Daily and hourly steps, distance, active minutes and estimated calories.
- Motion data your phone reports while counting steps: for example walking rhythm
  (cadence), how regular the steps are, whether the phone is carried in a pocket or hand,
  and short "walking evidence" summaries per minute. Raw sensor readings stay on your
  phone; only summaries are sent.
- Optional body details you enter (stride length, weight) for distance and calories.
- On Android phones with Health Connect (when this feature launches): your steps and
  exercise sessions, **read only**. We never write to Health Connect.

*Why:* to count your steps, run your goals, streaks and challenges, and check that steps
come from real walking. *Legal basis:* your **explicit consent** (asked when you sign up),
and the contract. Without it Step2Win can't work, so to withdraw it you delete your account.

### 4.3 Location (optional)
When you tap **Start a walk**, and only if you allow it, we record your GPS route while
that walk is running. Tracking stops when you finish. We store a simplified version of the
route for your walk history and delete the raw GPS points after 30 days. You can set a
**home privacy zone** that hides the start and end of your routes near home; we store it
only as one-way codes, not as coordinates.

We also compare the time and place of walks between accounts to detect one person using
several accounts or people walking for someone else (section 5). We don't show your route
to other users.

*Why:* walks with GPS are strong evidence that steps are real, so they count toward
challenge money. *Legal basis:* your consent, which you can withdraw at any time in
Settings › Privacy & your data. Your steps still count for goals, streaks and XP without it.

### 4.4 Money
Your wallet balance and transactions, deposits and withdrawals, M-Pesa numbers and
references, bank or paybill details you enter for withdrawals, challenge entries and
payouts, and payouts under review.
*Why:* to take entry fees and pay winnings. *Legal basis:* contract and legal obligations
(accounting, tax and anti-money-laundering rules).

### 4.5 Device and security information
Your device model and operating system, app version, a device identifier used to link your
account to one phone, a random ID for each app installation, whether the app and phone
pass Google Play Integrity (or Apple App Attest) checks, your time zone, the IP address you
sign in from, and sign-in attempts.
*Why:* to keep your account secure, stop fake devices and scripts, and show you where you
are signed in. *Legal basis:* legitimate interest (security and fraud prevention).

We keep your full IP address only while you are signed in on that device. For fraud
checks we keep a one-way code of your network (not the address itself) for 90 days.

### 4.6 Social features
Friends, friend requests, blocks, teams, weekly rankings and an activity feed with
milestones you choose to share (goal reached, streaks, badges, challenge milestones). Your
feed never shows locations, routes or money. You control who can find you and what you
share in the social settings.
*Why:* to provide the social features. *Legal basis:* contract.

### 4.7 Messages and support
Challenge chat messages and support tickets you send us.
*Why:* to run challenge chat and help you. *Legal basis:* contract.

## 5. Fair play, automated checks and profiling

Paid challenges only work if steps are real. To protect honest players we:

- **check each upload** (for example: is the pace possible for a human, does the motion
  look like walking, is the app genuine and the phone not tampered with);
- **look for linked accounts**: accounts that share a phone, an M-Pesa or payout number,
  a home network, walk at the same place and time, or have near-identical step patterns;
  staff see these links with numbers masked (only the last 3 digits);
- run a **risk model in test mode** that scores each day. It is not used for any decision
  today. If we ever use it for decisions we will update this policy first.

What these checks can do:
- count fewer of a day's steps **toward challenge money** (your goals, streaks and XP are
  not affected);
- **hold a payout** for a staff member to review, normally within 48 hours. The staff
  member releases the payout or, if the rules were broken, forfeits it. Forfeited money is
  shared among the other qualifying players (see the Fair Play Rules).

They never close or ban an account on their own. Every money decision is made by a person.
You can ask for a review of any decision and give your side through Settings › Help &
support; we reply within [7] days. This is how we respect your right not to be subject to a
decision based solely on automated processing (Data Protection Act s.35).

*Legal basis:* legitimate interest in preventing fraud and keeping challenges fair, which we
have balanced against your rights in a data protection impact assessment.

## 6. Who we share data with

We share only what each needs:

| Who | Why | Where |
|---|---|---|
| Render | Hosts our servers and database | United States |
| IntaSend and Safaricom M-Pesa | Process deposits and payouts | Kenya |
| Brevo (email) | Sends password-reset codes and "your data is ready" emails | European Union |
| Google | Sign in with Google, Google Play, Play Integrity checks, Health Connect (on your phone) | United States / global |
| Apple | Sign in with Apple, App Store, motion data on your iPhone | United States / global |
| Cloudflare, Vercel | Deliver our web app and staff console | Global |
| OpenStreetMap | Map images on the older day-route map (your IP and the map area) | United Kingdom / EU |
| [Sentry, if used] | Error reports without your personal details | United States |

**Other players** see your username, photo, and your steps and rank in challenges and
rankings you join. Friends see the milestones you choose to share.

We may disclose data when the law requires it (for example to the ODPC, the Kenya Revenue
Authority or a court), or to protect people from fraud.

We never sell your data and never share it for advertising.

## 7. How we protect your data

Encryption in transit (HTTPS/TLS) everywhere; passwords stored as secure hashes; staff
access limited to people who need it, with an audit log; masked phone numbers and IP
addresses in staff tools; step uploads tied to one signed-in device; automatic deletion
schedules (section 9). No system is perfect: if a breach puts you at risk we will tell you
and the ODPC as the law requires (within 72 hours to the ODPC).

## 8. International transfers

Our servers are run by Render in the **United States**, so your data is transferred outside
Kenya. We rely on [appropriate safeguards: Render's data processing agreement with standard
contractual clauses / proof of adequate safeguards given to the ODPC under s.49] and on
encryption. Email is handled in the European Union. You can ask us for a copy of the
safeguards.

## 9. How long we keep your data

| Data | How long |
|---|---|
| Account, profile, daily and hourly steps, walk history (simplified routes) | While your account is open |
| Detailed step upload data (motion summaries, device fields) | Reduced to daily totals after 90 days |
| Raw GPS points of walks | 30 days after the walk |
| Old background route points | 30 days |
| Full sign-in IP address | Until you sign out on that device (at most 90 days); network code 90 days |
| Sign-in attempt logs, password-reset records | 30 days |
| Automated fair-play scores (risk model) | 12 months |
| Money records (wallet, M-Pesa payments, withdrawals, payouts, payout reviews) | 7 years after the transaction, as required for financial records, even after you delete your account (without your contact details) |
| Consent records (what you agreed to and when) | As long as needed to show we had your consent [7 years] |
| Your downloadable data copy | 72 hours |

## 10. Your rights and how to use them

Under the Data Protection Act 2019 you can:

- **Be informed** (this policy).
- **Access** your data: Settings › Privacy & your data › *Download a copy of your data*
  gives you a ZIP file within minutes (one request per 24 hours).
- **Correct** your data: Settings › Personal details, or ask support.
- **Delete** your data: Settings › Delete account, or on the web at
  [https://step-2-win-app.onrender.com/account/delete/]. Money must be withdrawn and
  challenges finished first. We delete your personal data straight away and keep only
  money records (without your contact details) for the period in section 9.
- **Withdraw consent** for optional uses (location during walks) in Settings › Privacy &
  your data at any time.
- **Object** to processing based on our legitimate interests, and ask for a **human review**
  of automated decisions (section 5).
- **Data portability**: the download is in a machine-readable format (JSON).
- **Complain** to the Office of the Data Protection Commissioner (www.odpc.go.ke,
  [complaints@odpc.go.ke]) if you're unhappy with how we handle your data. Please contact
  us first so we can try to fix it.

We answer requests within [7] days and at most within the time the law allows.

## 11. Changes to this policy

When we change this policy we update the date above. If a change matters, the app asks you
to read and accept the new version before you continue.

## 12. Contact

[Entity name], [address], [privacy@step2win.app], [phone].
