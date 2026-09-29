# backend/legal: privacy and compliance drafts

> Everything here is a **DRAFT: have a Kenyan data-protection lawyer review it** before
> it is published, filed or submitted. Engineering wrote these from the code; they are not
> legal advice. Placeholders are in [square brackets]; open decisions are marked **[confirm]**,
> **[decide]** or **[verify]**.

| File | What it is | Who uses it |
|---|---|---|
| `DATA_INVENTORY.md` | Record of processing: every data category, where it's stored (model/field), purpose, lawful basis, access, retention, processors, transfers, known gaps | Owner, DPO, lawyer; engineers update it when models change |
| `PRIVACY_POLICY.md` | User-facing privacy policy (plain English, Kenya) | Published in the app (Admin > Legal documents) |
| `TERMS_ADDENDUM_ANTICHEAT.md` | Fair play, verification, walks, payout reviews (48 h), forfeit policy, appeals | Published as "Fair Play and Payout Review Rules" |
| `DPIA_DRAFT.md` | Data protection impact assessment (health + location + money + profiling + linkage) | DPO, lawyer, possibly the ODPC |
| `ODPC_REGISTRATION_CHECKLIST.md` | Registration with the Data Protection Commissioner and governance to-dos | Owner |
| `PLAY_DATA_SAFETY.md` | Google Play Data safety answers matching the code (incl. Phases 1b, 2a, 4) | Owner, in Play Console |
| `HEALTH_CONNECT_DECLARATION.md` | Health Connect permissions (Phase 1c: steps + exercise, read-only) | Owner, in Play Console; Phase 1c engineer |
| `LOCATION_PERMISSION_JUSTIFICATION.md` | Foreground-only location for user-started walks; FGS declaration; disclosure text | Owner, in Play Console / App Store |
| `APP_STORE_PRIVACY.md` | App Store privacy labels | Owner, in App Store Connect |
| `INCIDENT_RESPONSE.md` | Breach response, 72-hour ODPC notification | Owner, DPO, engineers |

## Publishing the policy documents

Legal documents live in the database (`apps.legal.LegalDocument`, Admin console > Legal
documents). Migration `apps/legal/migrations/0004_seed_privacy_drafts.py` stages the
Privacy Policy and the Fair Play Rules from the files above as **unpublished drafts**:

- a missing document is created as a draft; nothing is ever published automatically;
- an existing document gets the text in its draft slot only if that slot is empty, so an
  admin's pending edits and the live text are never overwritten.

To publish after legal review:
1. Admin console > Legal documents > open the document > review / edit the draft
   (remove the "DRAFT" notice and fill in the placeholders).
2. Publish. Tick **Notify users** when the change is material: every user is then asked to
   accept the new version (the consent gate in the app; `PrivacySettings.min_*_version`
   rises automatically).
3. Update the Terms and Conditions to reference the Fair Play Rules (and the 18+ rule).
4. If the database had no drafts staged (for example the migration ran before these files
   changed), paste the HTML from `python manage.py shell -c "from apps.legal.markdown_lite
   import markdown_to_html as m; print(m(open('legal/PRIVACY_POLICY.md', encoding='utf-8').read()))"`.

## Privacy features in the code (apps/privacy)

- **Consent** (`apps/privacy/consent.py`, `/api/privacy/consents/`): registration requires
  `terms` and `health_data`; `location_walks` is optional. Append-only ledger
  (`privacy.Consent`) tied to the published document versions.
- **Data export** (`/api/privacy/exports/`): one request per 24 h, built by the
  `privacy-process-exports` job every 5 min, ZIP stored in the DB, owner-only download for
  72 h.
- **Retention** (`apps/privacy/retention.py`, job `privacy-retention` hourly at :50 UTC):
  sync payloads trimmed at 90 days, legacy waypoints 30 days, risk_ml 12 months, interval
  results 12 months, reset codes and login logs 30 days, expired exports. Money never touched.
  Periods: `/api/privacy/admin/settings/` (staff) or Django admin > Privacy settings.
- **Deletion leftovers** (`apps/privacy/erasure.py`): sessions, reset codes, body
  measurements, staff audit text, login logs, export archives. Backfill for older
  deletions: `python manage.py privacy_scrub_deleted_accounts`.
- **Web**: registration checkboxes, `ConsentHost` gate + `requestConsent()`, Settings ›
  Privacy & your data (`/settings/privacy`).

## Integration steps for the lead (at merge time)

### Phase 1b (walks): location consent at walk start
1. Web, `step2win-web/src/screens/WalkScreen.tsx`, `BeforeStart`, the Start walk button:
   ```tsx
   import { requestConsent } from '../components/privacy/ConsentHost';
   // was: onClick={() => void startNewWalk()}
   onClick={() => void requestConsent('location_walks').then((ok) => { if (ok) void startNewWalk(); })}
   ```
   The prompt appears only until the user has agreed (and again after a material Privacy
   Policy update); it is also the Play "prominent disclosure" before the OS permission.
2. Backend, Phase 1b walk start view (`apps/steps/walk_views.py`, the start endpoint):
   ```python
   from apps.privacy.consent import has_consent
   if not has_consent(request.user, "location_walks"):
       return Response({"error": "Allow location for walks first.", "code": "LOCATION_CONSENT_REQUIRED"}, status=403)
   ```
   Add it only once the web build with step 1 is live (older builds don't ask).
3. Settings › Privacy & your data has a "Home privacy zone" row that goes to `/settings`.
   After the merge you can open Phase 1b's `PrivacyZoneSheet` directly from
   `PrivacyScreen.tsx` (it needs `stepsService.getPrivacyZone` for its `zone` prop).
4. The Phase 1b walk-point purge job stays the owner of walk retention; apps/privacy does
   not touch `WalkSession`.

### Phase 2a (linkage) and Phase 4 (social)
- Nothing to wire: exports skip apps that aren't installed and pick up `social.*` sections
  automatically; deletion is handled by those apps' own signals / hooks. The export
  counts active `linkage.LinkEdge` rows in `assessments.json` without details.
- `settings.py`, `urls.py`, `scheduler.py`: apps/privacy adds its entries in separate
  blocks (`CELERY_BEAT_SCHEDULE.update(...)`, `JOB_OPTIONS.update(...)`) to keep merges clean.

### Suggested small changes in other owners' code
- `apps/users/account_deletion.py`: block deletion while a `HeldPayout` is `held`
  ("a payout is under review"), otherwise the payout becomes forfeit-only.
- Challenge chat text after the author deletes the account (see DATA_INVENTORY §4).
- Staff console page for `/api/privacy/admin/settings/` (Django admin works meanwhile).
