# Rotating APP_SIGNING_SECRET (after the anti-cheat Phase 1a deploy)

## Why

Until Phase 1a the customer app bundle contained `VITE_APP_SIGNING_SECRET`, the same
value as the backend's `APP_SIGNING_SECRET`. Anything in a `VITE_*` variable ships inside
the JavaScript of the web build and the APK, so the secret must be treated as public.

Phase 1a removes every use that depended on it:

- `POST /api/steps/sync/` requires a server-issued step session (`session_id` +
  `session_token`, verified by the view). A client HMAC (`X-App-Signature`) alone is
  rejected with `403 SESSION_REQUIRED`. Every app build since commit b8e9ed7 uses sessions.
- `POST /api/auth/bind-device/` is authenticated by the user's JWT, rate limited, and
  limited to one active device per account; the HMAC `device_signature` is ignored.
- The web/app bundle no longer reads `VITE_APP_SIGNING_SECRET`.

The backend still reads `APP_SIGNING_SECRET` only for the emergency switch
`STEP_SYNC_ALLOW_HMAC_ONLY` (default off). Rotating it invalidates the leaked value.

## Steps (after the deploy is live)

1. Render dashboard → `step2win-backend` → Environment → `APP_SIGNING_SECRET` →
   replace with a new random value (64+ characters), e.g.
   `python -c "import secrets; print(secrets.token_urlsafe(64))"`.
   The Celery worker and beat services read it `fromService`, so they follow.
2. Save and redeploy the backend, worker and beat services.
3. Remove `VITE_APP_SIGNING_SECRET` from any local `step2win-web/.env*` file and from any
   CI or build machine that builds the web app / APK. It must never be set again.
4. Leave `STEP_SYNC_ALLOW_HMAC_ONLY` unset (off). Never turn it on with a secret that has
   been in a client build.
