# Personal data breach response plan

> **DRAFT: have a Kenyan data-protection lawyer review this.** KDPA s.43: notify the Data
> Protection Commissioner **within 72 hours** of becoming aware of a breach where there is
> a real risk of harm to data subjects, and notify affected data subjects **in writing
> within a reasonable time** unless an exception applies. A processor must notify us
> within **48 hours** of becoming aware (put this in every DPA).

## 1. Roles

| Role | Who | Backup |
|---|---|---|
| Incident lead (decides, coordinates) | [owner] | [ ] |
| DPO (notifications, register) | [DPO] | [ ] |
| Technical lead (contain, investigate) | [engineer] | [ ] |
| Communications (users, press) | [ ] | |
| Legal counsel | [firm, phone] | |

Contact list with phone numbers kept offline **[owner]**. Render, IntaSend, Brevo, Google
and Cloudflare support contacts in the same list.

## 2. What counts as a breach

Any accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or
access to personal data. Examples for Step2Win:
- database or backup exposed; Render account or staff console account compromised;
- a bug showing one user's data to another (wallet, steps, routes, export ZIP);
- leaked secrets (`SECRET_KEY`, `JWT_SIGNING_KEY`, `APP_SIGNING_SECRET`,
  `NETWORK_HASH_SECRET`, IntaSend keys, email credentials) — see `SECURITY_ROTATION.md`;
- a staff member looking at or exporting data without a work reason;
- a processor's breach (IntaSend, Brevo, Render);
- ransomware / loss of availability of the database.

## 3. Timeline

| When | Action |
|---|---|
| **Hour 0** (aware) | Whoever notices tells the incident lead immediately (any channel). Start the incident log: time, who, what is known. The 72 hours start now. |
| **0-4 h** | **Contain**: revoke/rotate credentials (SECURITY_ROTATION.md), disable the affected feature (maintenance mode or feature switch in Admin > Platform), revoke sessions (`DeviceSession`/token blacklist), block IPs, preserve logs (Render logs, `AuditLog`, auditlog `LogEntry`) before they rotate. |
| **4-24 h** | **Assess**: which data categories, how many people, sensitive data (health, location, financial)? Could it cause harm (fraud, SIM-swap, stalking via routes, embarrassment)? Encrypted? Recovered? Record the decision on "real risk of harm". |
| **by 72 h** | **Notify the ODPC** (e-portal / email **[verify current channel on odpc.go.ke]**) if there is a real risk of harm. If not everything is known, notify with what is known and send the rest in phases. |
| **ASAP after assessment** | **Notify affected users** in writing (email + in-app notice) when there is a real risk of harm, unless the data was unintelligible (e.g. encrypted with an uncompromised key) or the risk was removed. |
| **within 30 days** | Post-incident review: root cause, fixes, update the DPIA and this plan. |

Payment-related breaches: also tell IntaSend at once (and Safaricom through them) so they
can watch for fraud. Leaked phone numbers: warn users about SIM-swap and phishing.

## 4. ODPC notification content (s.43(5))

1. Description of the breach: what happened, when, how discovered.
2. Categories and approximate number of data subjects and records.
3. Likely consequences.
4. Measures taken or proposed to address the breach and reduce harm.
5. Identity and contact details of the DPO.
6. Recommendations to data subjects.
7. Whether and when data subjects were notified; cross-border aspects (Render USA).

## 5. User notification template

> Subject: Important: a security incident affecting your Step2Win account
>
> On [date] we found that [plain description]. The information involved was [list]. It did
> not include [e.g. your password, which we store only in a protected form].
> What we have done: [containment]. What you can do: [change your password; watch for
> messages asking for your M-Pesa PIN; we will never ask for it].
> If you have questions, contact our Data Protection Officer at [contact]. You can also
> complain to the Office of the Data Protection Commissioner (www.odpc.go.ke).

## 6. Breach register

Keep every incident, including ones not notified, with: date found, description, data and
people affected, risk decision and reasoning, notifications sent (time), actions, lessons.
Location: **[owner: a private document, not in git]**.

## 7. Technical aids that exist in the code

- Staff audit log (`admin_api.AuditLog`) and model change log (django-auditlog).
- Session revocation (`/api/auth/sessions/revoke-all/`; staff can disable users).
- Maintenance mode and feature switches (`apps/admin_api/platform.py`).
- Secret rotation guide (`backend/SECURITY_ROTATION.md`).
- Retention jobs limit what can leak (`apps/privacy/retention.py`).
