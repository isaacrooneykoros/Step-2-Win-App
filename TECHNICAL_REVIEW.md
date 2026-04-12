# Step2Win — Comprehensive Technical Review

**Reviewed by:** GitHub Copilot Coding Agent  
**Date:** 2026-04-12  
**Scope:** Full repository — `backend/`, `step2win-web/`, `step2win-admin/`

---

## Table of Contents

1. [High-Level Architecture & Project Structure](#1-high-level-architecture--project-structure)
2. [Technology Stack Assessment](#2-technology-stack-assessment)
3. [Code Quality Observations](#3-code-quality-observations)
4. [TypeScript & Python Components — Interaction & Boundary Clarity](#4-typescript--python-components--interaction--boundary-clarity)
5. [Security Review](#5-security-review)
6. [Performance Review](#6-performance-review)
7. [Testing & Quality Gates](#7-testing--quality-gates)
8. [Deployment / DevOps Readiness](#8-deployment--devops-readiness)
9. [Developer Experience Review](#9-developer-experience-review)
10. [Prioritised Recommendations](#10-prioritised-recommendations)

---

## 1. High-Level Architecture & Project Structure

### Monorepo Layout

```
Step-2-Win-App/
├── backend/            # Django 5 REST API (Python)
│   ├── apps/
│   │   ├── users/      # Auth, profiles, device sessions
│   │   ├── challenges/ # Core challenge engine + tie resolution
│   │   ├── steps/      # Health sync, anti-cheat, location waypoints
│   │   ├── wallet/     # Internal ledger (WalletTransaction + Withdrawal)
│   │   ├── payments/   # M-Pesa via PochPay gateway
│   │   ├── gamification/ # XP, levels, badges, leaderboards
│   │   ├── legal/      # Privacy policy / ToS versioning
│   │   ├── admin_api/  # Internal admin REST endpoints
│   │   └── core/       # Shared throttles, sanitizers
│   └── step2win/       # Django project config (settings, URLs, ASGI, Celery)
│
├── step2win-web/       # React 18 + Capacitor mobile/web app (TypeScript)
│   └── src/
│       ├── screens/    # Full-screen views (tabs)
│       ├── components/ # Reusable UI components
│       ├── services/api/ # Typed Axios API clients per domain
│       ├── store/      # Zustand state stores
│       ├── hooks/      # React hooks (health sync, deposit, chat)
│       └── types/      # Shared TypeScript interfaces
│
├── step2win-admin/     # React 19 SPA — staff/admin dashboard (TypeScript)
│   └── src/
│       ├── pages/      # Admin page views
│       ├── components/ # Admin UI widgets
│       ├── services/   # API calls to admin endpoints
│       └── store/      # Zustand auth + state
│
├── release_gate.py     # Pre-release validation script
├── render.yaml         # Render.com multi-service deployment manifest
├── Procfile            # Heroku/Railway Procfile
├── .github/workflows/  # CI (release gate + Android build)
└── .pre-commit-config.yaml # Secret detection + file hygiene hooks
```

### Architectural Pattern

The project follows a **clean layered architecture**:

- **Frontend (step2win-web)** is a Capacitor-wrapped React SPA that produces both a web PWA and an Android APK from the same codebase.
- **Admin (step2win-admin)** is a separate React SPA targeting staff, kept cleanly isolated from user-facing code.
- **Backend (Django/DRF)** exposes a REST API consumed by both frontends. WebSocket support via Django Channels handles real-time challenge group chat.
- **Celery** handles all asynchronous work: nightly fraud scans, payout finalization, streak updates, PochPay token refresh, and payment reconciliation.
- **PochPay** is the M-Pesa payment gateway integration (Kenya-specific), with token caching in Redis and a full callback/reconciliation loop.

The separation of concerns is well-designed. Domain logic lives in `apps/<domain>/services.py` or dedicated modules (`anti_cheat.py`, `tie_resolution.py`, `pochipay.py`), keeping views thin.

---

## 2. Technology Stack Assessment

### Backend

| Layer | Technology | Version | Assessment |
|---|---|---|---|
| Web framework | Django | 5.0.9 | ✅ Current LTS |
| REST API | Django REST Framework | 3.15.0 | ✅ Stable |
| Auth | JWT (SimpleJWT) | 5.5.1 | ✅ Good — token blacklisting enabled |
| Task queue | Celery | 5.3.6 | ✅ |
| Task scheduler | django-celery-beat | 2.7.0 | ✅ |
| ASGI server | Daphne | 4.1.2 | ✅ Required for Channels |
| WSGI server | Gunicorn | 21.2.0 | ✅ |
| Database | PostgreSQL via psycopg2-binary | 2.9.10 | ✅ |
| Caching / Broker | Redis (conditional) | — | ✅ Falls back to SQLite |
| Real-time | Django Channels | 4.1.0 | ⚠️ Using InMemoryChannelLayer — see §6 |
| API docs | drf-spectacular (OpenAPI) | 0.27.0 | ✅ |
| Security extras | django-axes, django-defender, django-auditlog, bleach | — | ✅ Defense-in-depth |
| Error tracking | Sentry SDK | 1.40.0 | ✅ |
| Static files | WhiteNoise | 6.9.0 | ✅ |
| Document parsing | mammoth, PyPDF2 | — | ✅ |

### Frontend (step2win-web)

| Technology | Version | Assessment |
|---|---|---|
| React | 18.2 | ✅ |
| TypeScript | 5.3.3 | ✅ |
| Vite | 5.0.11 | ✅ |
| Capacitor | 5.6 | ✅ Cross-platform wrapper |
| Tailwind CSS | 3.4 | ✅ |
| Zustand | 4.4.7 | ✅ Lightweight state |
| TanStack Query | 5.17 | ✅ Server state management |
| React Router | 6.21 | ✅ |
| Axios | 1.6.5 | ✅ |
| crypto-js | 4.2.0 | ⚠️ Client-side HMAC — see §5 |
| Leaflet | 1.9.4 | ✅ Maps |
| uuid | 13.0.0 | ✅ Idempotency keys |

### Admin (step2win-admin)

| Technology | Version | Assessment |
|---|---|---|
| React | 19.2 | ✅ Newer than web (minor version gap) |
| TypeScript | 5.9.3 | ✅ |
| Vite | 7.3.1 | ✅ |
| Tailwind CSS | 4.2.1 | ⚠️ V4 (different config from web's v3) |
| TipTap | 3.20.1 | ✅ Rich-text editor for legal docs |
| Recharts | 3.8.0 | ✅ Analytics charts |
| DOMPurify | 3.3.3 | ✅ HTML sanitisation in browser |
| date-fns | 4.1.0 | ✅ |
| Zustand | 5.0.12 | ⚠️ V5 — different API from web's v4 |

**Overall**: The stack is modern, sensibly chosen, and appropriate for a mobile-first fintech application targeting the Kenyan market. The main tension is Tailwind v3 vs v4 and Zustand v4 vs v5 between the two frontends — a minor inconsistency worth standardising when convenient.

---

## 3. Code Quality Observations

### Strengths

- **Thin views, fat services.** Domain logic is consistently extracted into `services.py` files or dedicated modules (`anti_cheat.py`, `tie_resolution.py`, `pochipay.py`). Views are primarily orchestrators.
- **Atomic transactions everywhere financial.** `select_for_update()` with `transaction.atomic()` is correctly used in `challenges/views.py`, `challenges/services.py`, and `payments/views.py`. This prevents double-spend race conditions.
- **Comprehensive model design.** Models include proper indexes, sensible `null`/`blank` choices, use of `Decimal` for monetary values (not `float`), and thorough `help_text` documentation.
- **`dataclasses` in tie resolution.** `tie_resolution.py` uses `@dataclass` for `ResolvedParticipant`, keeping the resolution logic pure and testable.
- **Anti-cheat is well-structured.** `anti_cheat.py` uses a `CheckResult` accumulator pattern with named checks, making it easy to add/remove checks independently.
- **Custom exception handler.** A global `custom_exception_handler` in `step2win/exceptions.py` normalises all API error shapes.
- **Consistent input sanitisation.** `apps/core/sanitizers.py` uses `bleach` for all user-facing text. `RegisterSerializer` and others call sanitizers before persistence.
- **OpenAPI documentation.** `drf-spectacular` is integrated with `@extend_schema` decorators, producing a rich API schema.
- **Idempotency.** Step sync uses an idempotency key (`X-Idempotency-Key`) backed by a Redis `SET NX` check, preventing duplicate processing.
- **Token management for PochPay.** `pochipay.py` caches the PochPay JWT in Redis and refreshes it proactively via Celery — the token is never stored in the database.

### Areas for Improvement

- **`payments/views.py` is 902 lines.** This file handles deposit initiation, deposit callback, payout, withdrawal, reconciliation, and webhook parsing in one file. Splitting into at least `deposit_views.py`, `withdrawal_views.py`, and `webhook_views.py` would improve navigability.
- **`challenges/views.py` mixes list/detail/action logic.** Standard DRF `ViewSet` / `APIView` class-based views would replace the long chain of `@api_view` functions with less boilerplate.
- **`steps/views.py` is 602 lines.** The sync view alone, with all the Celery/Redis/anti-cheat orchestration, is 150+ lines. Extracting a `StepSyncService` class would improve testability.
- **N+1 streak calculation.** `tasks.update_user_streak_records` iterates over every active user and issues a database query per user per calendar day in a Python loop (see §6).
- **`WalletTransaction.user` is nullable.** The field has `null=True, blank=True`. Since every transaction belongs to a user, this should be `NOT NULL`. The only reason to allow null would be system-level fee deductions, and those should be modelled differently (e.g., a `Challenge` FK instead).
- **`Withdrawal.account_details` is a plain `TextField`.** This stores bank account/M-Pesa details without any structure. Consider a `JSONField` with a validated schema or a dedicated `BankAccount` model to enable reconciliation and validation.
- **`admin store uses localStorage` for refresh tokens.** The admin panel stores the JWT refresh token in `localStorage` (accessible to JavaScript). Prefer `httpOnly` cookies or at minimum `sessionStorage` (tab-scoped, cleared on close).
- **`distance_km` estimation in `useHealthSync.ts`.** When Health Connect doesn't return distance, the hook estimates it as `steps * 0.0008 km`. This is a rough proxy that the anti-cheat engine will then validate, potentially causing false `distance_too_low` flags for users with short strides.

---

## 4. TypeScript & Python Components — Interaction & Boundary Clarity

### Communication Pattern

The TypeScript frontends communicate with the Python backend **exclusively via REST API**. There is no shared type generation (e.g., `openapi-ts`). The boundary is:

```
step2win-web/src/services/api/*.ts  ←→  backend/apps/*/serializers.py
step2win-admin/src/services/*.ts    ←→  backend/apps/admin_api/views.py
```

### Boundary Clarity Assessment

| Concern | Status | Notes |
|---|---|---|
| API contracts | ⚠️ Manual | Types in `step2win-web/src/types/` are hand-written; no code generation from OpenAPI schema |
| Serializer ↔ Type alignment | ⚠️ Manual | Drift between `serializers.py` and `types/*.ts` is a maintenance risk |
| Authentication | ✅ Consistent | Both frontends use Bearer JWT via Axios interceptors with refresh logic |
| HMAC signing | ❌ Broken by design | Signing secret placed in frontend bundle — see §5 |
| WebSocket (chat) | ✅ Typed | `useGroupChat.ts` hook manages WS lifecycle with typed message interfaces |
| Error handling | ✅ Consistent | Both frontends check `error.response.data.error` / `.detail` / `.message` |
| Pagination | ⚠️ Partial | Backend uses `PageNumberPagination` but not all frontend list views handle `next`/`previous` |

### Recommendation: Automate Type Generation

The project has a full OpenAPI schema at `Step2Win API.yaml`. Consider adding `openapi-typescript` or `@hey-api/openapi-ts` to generate types automatically:

```bash
# In step2win-web/
npx openapi-ts --input ../../Step2Win\ API.yaml --output src/types/api-generated.ts
```

This eliminates hand-written type drift and ensures the frontend never calls endpoints with the wrong shape.

---

## 5. Security Review

### ✅ Strengths

| Control | Location | Notes |
|---|---|---|
| Brute-force protection | `settings.py`, `auth_views.py` | django-axes + django-defender + custom cache counter — triple-layered |
| JWT blacklisting | `settings.py` | `BLACKLIST_AFTER_ROTATION = True`; refresh token rotated on every use |
| Device session tracking | `users/models.py` (DeviceSession) | JTI stored per device; user can revoke any session |
| Audit logging | `users/models.py`, `wallet/models.py` | django-auditlog on `User` and `WalletTransaction` |
| Rate limiting | `core/throttles.py`, `settings.py` | Per-scope limits for login (5/min), deposits (5/min), withdrawals (3/min), step sync (10/min) |
| SQL injection | Django ORM | ORM-parameterised queries; no raw SQL found |
| XSS — backend | `core/sanitizers.py` | `bleach.clean` strips all HTML from text fields |
| XSS — admin frontend | `step2win-admin/` | DOMPurify used when rendering legal document HTML |
| CSP | `middleware.py` | Applied to every response; configurable via env |
| Security headers | `middleware.py`, `settings.py` | HSTS, X-Frame-Options DENY, Referrer-Policy, X-Content-Type-Options |
| HTTPS enforcement | `settings.py` | `SECURE_SSL_REDIRECT=True` in production |
| Admin URL obscured | `settings.py` | `ADMIN_URL` defaults to `admin-s2w-secure/`, configurable via env |
| Secret key validation | `settings.py` | Raises `ImproperlyConfigured` if `SECRET_KEY` is weak/missing in production |
| PochPay token | `pochipay.py` | Cached in Redis, never stored in database |
| CSRF | `settings.py` | Secure CSRF cookies + trusted origins validation |
| Webhook HMAC | `payments/views.py` | PochPay callbacks verified with `HMAC-SHA256(POCHIPAY_WEBHOOK_SECRET, payload)` |

### ❌ Critical Issue: HMAC Signing Secret Exposed in Frontend Bundle

**File:** `step2win-web/src/hooks/useHealthSync.ts:10`  
**File:** `step2win-web/.env.staging` (tracked in git)

```typescript
// useHealthSync.ts — this secret ships in your compiled JavaScript
const APP_SIGNING_SECRET = import.meta.env.VITE_APP_SIGNING_SECRET || 'change-me-in-production';
```

**The `APP_SIGNING_SECRET` is a Vite environment variable prefixed with `VITE_`.** All `VITE_*` variables are embedded directly into the compiled JavaScript bundle, meaning anyone who downloads the APK or visits the web app can extract this secret with basic browser devtools or `apktool`.

Once the secret is known, the `HMACSignatureMiddleware` in `backend/apps/steps/middleware.py` provides **zero protection** — any attacker can forge valid signatures with arbitrary step counts.

Additionally, `step2win-web/.env.staging` is **committed to the repository** and contains what appears to be an actual signing secret:
```
VITE_APP_SIGNING_SECRET=hen66d3WunwELeHi5DUxB6fSUTO3ZSdFfKfG2wYZnI4c9Pr8fgKpFlW4Icb9VQsU
```

**This secret must be treated as compromised.** See §10 for the remediation path.

### ⚠️ Medium Issues

| Issue | Location | Notes |
|---|---|---|
| CSP allows `unsafe-inline` for scripts and styles | `middleware.py` | Weakens XSS protection; acceptable for Capacitor apps but should be tightened for the web variant |
| Admin refresh token in `localStorage` | `step2win-admin/src/store/authStore.ts` | XSS-accessible; prefer `httpOnly` cookie or `sessionStorage` |
| `ALLOW_HOSTS` production guard breaks testserver | `settings.py` | The production guard bans `testserver` from `ALLOWED_HOSTS`, which means CI integration tests must use `DEBUG=True` — currently handled but fragile |
| Withdrawal `account_details` stored as unstructured text | `wallet/models.py` | PII (phone numbers) in a plain `TextField` without explicit encryption at rest |
| `InMemoryChannelLayer` used for WebSockets | `settings.py` | Not a security issue but channels will break under multi-worker deployment — see §6 |
| `APP_SIGNING_SECRET` has no production guard | `settings.py` | Unlike `SECRET_KEY`, a missing or empty `APP_SIGNING_SECRET` does not raise `ImproperlyConfigured` |

### ⚠️ Low Issues

| Issue | Location |
|---|---|
| `celery_broker.db` committed to repository | `backend/celery_broker.db` |
| `.env.staging` tracked in git with a possible real secret | `step2win-web/.env.staging` |
| `socket.io` / WebSocket endpoint has no explicit auth timeout | `challenges/consumers.py` |

---

## 6. Performance Review

### ✅ Strengths

- **Database indexes** on every high-traffic lookup: `user + date`, `user + is_active`, `refresh_jti`.
- **`select_related` / `select_for_update`** used in financial paths.
- **Celery** offloads all slow work (fraud scan, payout finalization, streak updates) from the request cycle.
- **Redis caching** for PochPay token and step-sync idempotency keys.
- **WhiteNoise** with `CompressedManifestStaticFilesStorage` for efficient static file serving.
- **Pagination** on all list endpoints (`PAGE_SIZE = 20`).
- **API timeout** set to 15 s in `client.ts` to prevent hanging connections on the mobile app.
- **`conn_max_age=600`** on the PostgreSQL connection pool.

### ⚠️ Bottlenecks

#### 1. N+1 Streak Calculation (High Impact)

**File:** `backend/apps/steps/tasks.py` — `update_user_streak_records`

```python
for user in users:                          # loads all active users
    while True:
        has_steps = HealthRecord.objects.filter(   # 1 query per day per user
            user=user, date=check_date, ...
        ).first()
```

For 10,000 users with 30-day streaks this is **300,000 database queries** per nightly run. Replace with a window function or aggregation query.

**Recommended fix:**
```python
from django.db.models import Count, Max
# Compute last step date per user in one query, then build streak in Python
# or use PostgreSQL's LAG() window function via RawSQL
```

#### 2. `nightly_fraud_scan` Iterates All Active Users

**File:** `backend/apps/steps/tasks.py` — `nightly_fraud_scan`

Similar pattern: loads all users with health records in the last 14 days, then issues per-user queries inside the loop. Use `annotate()` + `values()` to compute high-step-day counts in one aggregation query.

#### 3. `InMemoryChannelLayer` Won't Scale

**File:** `backend/step2win/settings.py`

```python
CHANNEL_LAYERS = {
    'default': {
        'BACKEND': 'channels.layers.InMemoryChannelLayer',
    },
}
```

The in-memory channel layer is **per-process**. As soon as Gunicorn runs with multiple workers (`-w 4` in the Procfile), chat messages sent via one worker will never reach users connected to a different worker. Switch to `channels_redis.core.RedisChannelLayer` when `USE_REDIS=True`.

#### 4. Polling vs. Push on Deposit Status

**File:** `step2win-web/src/hooks/useDeposit.ts`

The mobile app polls `/api/payments/mpesa/deposit-status/{order_id}/` every 5 seconds for up to 2 minutes (24 attempts). Since Django Channels + WebSockets are already deployed, the backend could instead push a `deposit_completed` event over the existing WebSocket connection, eliminating all polling.

#### 5. `celery_broker.db` on Local SQLite Broker

In non-Redis environments (`USE_REDIS=False`), Celery uses an SQLite file (`sqla+sqlite:///celery_broker.sqlite3`) as the message broker. SQLite-backed Celery is not suitable for concurrent workers and will deadlock under load. This is acceptable for local development only.

---

## 7. Testing & Quality Gates

### Existing Tests

| Location | Type | Coverage |
|---|---|---|
| `backend/apps/users/tests.py` | Django `APITestCase` | Health endpoint, register/login/profile flow |
| `backend/apps/challenges/tests.py` | Django `APITestCase` | Join challenge (balance deduction, participant creation), create challenge |
| `backend/test_anticheat.py` | Integration script | Anti-cheat: impossible_rate, daily_cap, distance_too_low |
| `backend/test_signed_sync.py` | Integration script | HMAC signing: valid, invalid sig, idempotency, stale timestamp |
| `backend/smoke_test.py` | Smoke test script | Not reviewed in detail |
| `backend/validate_integration.py` | Integration validator | Not reviewed in detail |

### Coverage Gaps

The following critical paths have **no automated tests**:

- `apps/payments/` — deposit initiation, callback processing, withdrawal request, reconciliation
- `apps/steps/views.py` — sync endpoint, anti-cheat integration test
- `apps/wallet/views.py` — balance calculations, withdrawal workflow
- `apps/gamification/` — XP award, badge granting, leaderboard
- `apps/legal/` — document publish/version workflow
- `apps/challenges/services.py` — `finalize_challenge`, tie resolution (this is the most financially critical code path and should have extensive tests)
- `apps/challenges/tie_resolution.py` — edge cases (all tie, partial tie, dead-heat prize merging)

The `test_anticheat.py` and `test_signed_sync.py` scripts are integration tests that require a running database — they are not picked up by `manage.py test`. They should be converted to `APITestCase` subclasses.

### Quality Gates

| Gate | Status | Notes |
|---|---|---|
| `python manage.py check --deploy` | ✅ CI | Runs in `release_gate.py` with production env vars |
| Migration check | ✅ CI | `makemigrations --check --dry-run` |
| Django unit tests | ✅ CI | `manage.py test` |
| Frontend TypeScript build | ✅ CI | `tsc && vite build` for both frontends |
| ESLint | ✅ CI | Both frontends |
| Pre-commit hooks | ✅ Local | `detect-secrets`, `detect-private-key`, no-commit-to-main |
| Code coverage measurement | ❌ Missing | No `coverage.py` or Istanbul configured |
| Backend linting (ruff/flake8/pylint) | ❌ Missing | No Python linter in CI |
| Security dependency scanning | ❌ Missing | No `pip-audit`, `safety`, or `npm audit` in CI |
| End-to-end tests | ❌ Missing | No Playwright/Cypress tests |

---

## 8. Deployment / DevOps Readiness

### Deployment Targets

The project supports **two platforms**, both fully configured:

| Platform | Config file | Status |
|---|---|---|
| Render.com | `render.yaml` | ✅ Three services: web, celery-worker, celery-beat |
| Heroku / Railway | `Procfile` (root + `backend/`) | ⚠️ Duplicate `release:` entry (see below) |

### Render.com (`render.yaml`)

Well-structured. Key observations:
- `SECRET_KEY` and `APP_SIGNING_SECRET` use `generateValue: true` — Render auto-generates these. ✅
- Sensitive keys (`DATABASE_URL`, `REDIS_URL`, `POCHIPAY_*`) use `sync: false` — must be set manually in the Render dashboard, not committed. ✅
- `CELERY_RESULT_BACKEND: django-db` hardcoded — fine for SQLite fallback but should be `redis://...` in production for performance. ⚠️
- All three services (web, worker, beat) repeat the same 22 env vars. Render supports shared environment groups — using one would halve the maintenance surface.

### Procfile (root)

```
release: bash -lc 'cd backend && python manage.py migrate && python manage.py collectstatic --noinput'
web: bash -lc 'cd backend && gunicorn -w 4 ...'
worker: bash -lc 'cd backend && celery -A step2win worker ...'
beat: bash -lc 'cd backend && celery -A step2win beat ...'
```

**Issue:** The root `Procfile` has **two `release:` entries** — the second one (without `cd backend`) would override the first. This would cause Railway/Heroku deployments to fail to run migrations because `manage.py` is not in `$PATH` at root level.

**Fix:**
```
# Remove the duplicate bare entries (last 4 lines of the root Procfile)
```

### Build Scripts

`backend/render-build.sh`, `render-start.sh`, `render-worker.sh`, `render-beat.sh` are present and appear correct. `render-build.sh` runs `pip install`, `collectstatic`, and `migrate`. This is appropriate.

### Environment Configuration

`backend/.env.example` is comprehensive and well-documented. All required vars are listed with clear comments. The `APP_SIGNING_SECRET` default is `change-this-app-signing-secret` — acceptable for an example file.

`step2win-web/.env.example` is minimal (only `VITE_GOOGLE_CLIENT_ID`). It should also document `VITE_API_BASE_URL`.

### Runtime

`backend/runtime.txt` specifies `python-3.11.9` for Render. The CI workflow uses Python 3.11 and Node 20. Versions are consistent.

### Release Safety

`release_gate.py` is an excellent pre-release script that:
1. Runs `manage.py check --deploy` with production-like env
2. Verifies no pending migrations
3. Runs Django test suite
4. Lints and builds both frontends
5. Optionally builds the Android APK

This is a strong safety net. The main gap is that it does not run `pip-audit` or `npm audit` for known CVEs.

---

## 9. Developer Experience Review

### Onboarding Friction

| Item | Quality | Notes |
|---|---|---|
| Backend `README.md` | ✅ Good | Clear setup instructions, dev commands |
| Frontend `README.md` | ✅ Good | Vite dev server, Capacitor Android setup |
| Admin `README.md` | ✅ Basic | Minimal but present |
| `.env.example` | ✅ Detailed | All required vars documented |
| `RAILWAY_DEPLOYMENT.md` | ✅ Comprehensive | Step-by-step Railway setup |
| `RAILWAY_READINESS_CHECKLIST.md` | ✅ Good | Pre-launch checklist |
| `AUDIT_REPORT.md` | ✅ Present | Previous self-audit |
| Makefile / task runner | ❌ Missing | No `make dev`, `make test`, etc. |
| Docker / docker-compose | ❌ Missing | Developers must install Postgres and Redis manually |

### Setup Steps

A new developer must manually:
1. Install Python 3.11, Node 20, PostgreSQL, Redis
2. Copy `backend/.env.example` to `backend/.env` and fill in credentials
3. Run `pip install -r requirements.txt` inside `backend/`
4. Run migrations, create superuser
5. Separately start Celery worker and beat
6. Run `npm ci && npm run dev` in both frontend directories

This is **5–7 manual steps** before seeing any output. A `docker-compose.yml` providing Postgres, Redis, and the Django server would reduce this to `docker compose up`.

### API Documentation

- Swagger UI available at `/api/docs/` in `DEBUG` mode. ✅
- A static `Step2Win API.yaml` is committed to the repo for reference. ✅
- The schema is not auto-generated in CI — it could drift from the actual implementation over time. Consider adding a `spectacular --generate` step to the release gate.

### Code Style

- **Python:** No linter or formatter (`black`, `ruff`, `flake8`) is configured or enforced. Code quality is high but inconsistent indentation and style choices are present (e.g., aligned assignment operators in some files vs. standard in others).
- **TypeScript:** ESLint is configured in both frontends with strict rules (`max-warnings 0`).
- **Pre-commit:** hooks cover secret detection and file hygiene but not Python code style.

---

## 10. Prioritised Recommendations

### 🔴 Quick Wins (Low Effort / High Impact)

#### QW-1 — Rotate the compromised `.env.staging` signing secret
**Impact:** Critical security fix  
**Files:** `step2win-web/.env.staging`, backend env vars

The value `hen66d3WunwELeHi5DUxB6fSUTO3ZSdFfKfG2wYZnI4c9Pr8fgKpFlW4Icb9VQsU` is committed to git history and must be considered compromised. Generate a new `APP_SIGNING_SECRET` and update it everywhere:

1. Generate a new secret: `python -c "import secrets; print(secrets.token_urlsafe(48))"`
2. Update `VITE_APP_SIGNING_SECRET` in your Render/Railway env vars.
3. Update `APP_SIGNING_SECRET` in `backend/.env` (development) and all hosted environments.
4. Remove `step2win-web/.env.staging` from git tracking: `git rm --cached step2win-web/.env.staging`
5. Add `**/.env.staging` to root `.gitignore`.

#### QW-2 — Add `APP_SIGNING_SECRET` production guard
**Impact:** Medium security hardening  
**File:** `backend/step2win/settings.py`

```python
if not DEBUG:
    if not APP_SIGNING_SECRET or APP_SIGNING_SECRET in {'', 'change-this-app-signing-secret'}:
        raise ImproperlyConfigured('APP_SIGNING_SECRET must be set in production.')
```

#### QW-3 — Clarify the two-Procfile setup in documentation
**Impact:** Deployment clarity / onboarding friction  
**Files:** `Procfile` (root), `backend/Procfile`

Two Procfiles exist for different deployment contexts:
- **Root `Procfile`** — for Heroku/Railway root-based deployments; uses `bash -lc 'cd backend && ...'`
- **`backend/Procfile`** — for Render.com where `rootDir: backend` is already set; commands run from within `backend/`

Both are correct for their respective platforms, but this is not documented anywhere. Add a comment at the top of each file (or a note in `README.md`) explaining which platform each targets to prevent accidental misconfiguration.

#### QW-4 — Add `celery_broker.db` to `.gitignore`
**Impact:** Repository hygiene  
**File:** `.gitignore`

```
backend/celery_broker.db
backend/celery_broker.sqlite3
```

Then: `git rm --cached backend/celery_broker.db`

#### QW-5 — Add Python linter to CI
**Impact:** Code quality gate  
**File:** `.github/workflows/*.yml` / `release_gate.py`

```bash
pip install ruff
ruff check backend/
```

Ruff is near-zero config and covers flake8 + isort + pyupgrade rules.

#### QW-6 — Add security dependency scanning to CI
**Impact:** Catches known CVEs early

```bash
pip install pip-audit
pip-audit -r backend/requirements.txt

cd step2win-web && npm audit --audit-level=high
cd step2win-admin && npm audit --audit-level=high
```

#### QW-7 — Fix admin `localStorage` refresh token
**Impact:** Security improvement for admin staff  
**File:** `step2win-admin/src/store/authStore.ts`

Replace `localStorage.setItem(REFRESH_KEY, refresh)` with `sessionStorage` to limit token lifetime to the browser session. For hardened deployments, use `httpOnly` cookies.

---

### 🟡 Medium-Term Improvements

#### MT-1 — Replace client-side HMAC with server-side device attestation
**Impact:** The current HMAC scheme cannot provide meaningful anti-cheat protection once the secret is extractable from the bundle.

**Option A (Recommended short-term):** Remove `VITE_APP_SIGNING_SECRET` entirely. Instead, sign requests on the backend using the JWT `user_id` + a server-held device nonce. The middleware already has access to the authenticated user — use `user_id` + a rolling nonce stored in the database/cache.

**Option B (Long-term):** Integrate Google Play Integrity API (Android) or Apple DeviceCheck (iOS) via Capacitor plugins. These provide genuine hardware-backed app attestation that cannot be spoofed from a modified APK.

#### MT-2 — Fix `InMemoryChannelLayer` for multi-worker chat
**Impact:** Chat broken in production under `gunicorn -w 4`  
**File:** `backend/step2win/settings.py`

```python
if USE_REDIS:
    CHANNEL_LAYERS = {
        'default': {
            'BACKEND': 'channels_redis.core.RedisChannelLayer',
            'CONFIG': {'hosts': [os.getenv('REDIS_URL', 'redis://localhost:6379/0')]},
        }
    }
```

Add `channels_redis` to `requirements.txt`.

#### MT-3 — Fix N+1 streak and fraud-scan tasks
**Impact:** Prevents nightly task timeout at scale  
**File:** `backend/apps/steps/tasks.py`

Replace per-user-per-day loops with bulk aggregation:

```python
from django.db.models import Max, Count, Q

# Example: get last_step_date per user in one query
last_step_dates = HealthRecord.objects.filter(
    user__is_active=True, steps__gt=0
).values('user_id').annotate(last_date=Max('date'))
```

Then compute streaks in Python from the aggregated data.

#### MT-4 — Split `payments/views.py`
**Impact:** Maintainability  
Split into: `deposit.py`, `withdrawal.py`, `webhook.py`, `reconciliation.py`. Each file under 200 lines.

#### MT-5 — Add `coverage.py` to the test suite
**Impact:** Visibility into untested paths

```bash
pip install coverage
coverage run --source=apps manage.py test
coverage report --fail-under=70
```

Add to `release_gate.py`.

#### MT-6 — Add tests for financially critical paths
**Priority order:**
1. `apps/challenges/tie_resolution.py` — all tie scenarios
2. `apps/challenges/services.py` — `finalize_challenge` with real/refund payouts
3. `apps/payments/views.py` — deposit callback (credited / failed / duplicate)
4. `apps/wallet/views.py` — balance floor enforcement

#### MT-7 — Automate OpenAPI type generation
**Impact:** Eliminates frontend/backend type drift  
Add `openapi-typescript` to both frontend build steps. Run schema generation in CI and commit the generated types.

#### MT-8 — Standardise frontend library versions
- Align Zustand to the same major version across `step2win-web` (v4) and `step2win-admin` (v5).
- Align Tailwind CSS: both frontends or neither using v4.

#### MT-9 — Replace deposit polling with WebSocket push
**Impact:** Reduced server load + better UX  
**File:** `step2win-web/src/hooks/useDeposit.ts`

Since Channels is already deployed, add a `deposit_update` consumer event. The backend already has `_notify_user` in `payments/views.py` — wire it to the existing WebSocket channel.

---

### 🔵 Long-Term Architectural Improvements

#### LT-1 — Mobile app anti-cheat: server-side device attestation
As described in MT-1 Option B. Integrate Google Play Integrity API and Apple DeviceCheck. This is the only reliable way to verify that step data originates from a genuine, unmodified installation of your app.

#### LT-2 — Add a `docker-compose.yml` for local development
Provide Postgres + Redis containers with pre-seeded data. Reduces new developer onboarding from ~45 minutes to `docker compose up`.

#### LT-3 — Migrate to PostgreSQL-native advisory locks for wallet operations
Currently `select_for_update()` on the User row serialises all wallet operations for a given user. For high-throughput scenarios, PostgreSQL advisory locks on `user_id` allow finer-grained concurrency control without locking the entire User row.

#### LT-4 — Extract `anti_cheat.py` into a standalone service / library
The anti-cheat engine has no Django dependencies. Packaging it as a pure Python library would allow it to be unit-tested in isolation (no database setup required) and reused across services.

#### LT-5 — Consider CQRS for the leaderboard
The challenge leaderboard is recomputed on every request from live `HealthRecord` data. At scale, a pre-computed leaderboard snapshot (updated via Celery on each step sync) would dramatically reduce query load.

#### LT-6 — Add structured API versioning
Currently all endpoints are at `/api/*/`. Adding versioning (`/api/v1/*/`) now, before the app is widely deployed, is far less costly than retrofitting it later.

#### LT-7 — Formalise a `Makefile` / `justfile` for developer commands
Document and standardise: `make dev`, `make test`, `make migrate`, `make worker`, `make lint`. This reduces onboarding documentation to a single reference.

---

## Summary

Step2Win is a well-conceived, technically ambitious application for the Kenyan fintech/fitness market. The backend in particular shows strong engineering discipline — proper atomic transactions, defense-in-depth security layers, a rigorous anti-cheat engine, and a comprehensive tie-resolution algorithm. The frontend shows a clean service-layer pattern and sensible use of modern React tooling.

The most important issues to address before wider launch are:

1. **Rotate the compromised signing secret** (committed in `.env.staging`) — **do this today**.
2. **Acknowledge that client-side HMAC cannot protect server-side anti-cheat** and design a proper attestation strategy.
3. **Fix the `InMemoryChannelLayer`** before multi-worker production deployment to avoid silent chat failures.
4. **Add financial path tests** — especially `finalize_challenge` and `deposit_callback` — which handle real money.
