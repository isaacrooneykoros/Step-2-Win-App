# App Debug Runbook (Android)

## One Command (this machine)
From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\run-android-debug.ps1
```

What it does:
1. Verifies the current Git branch (expects `main`).
2. Checks backend health at `http://127.0.0.1:8000/api/health/`.
3. Builds `step2win-web`.
4. Runs `npx cap sync android`.
5. Runs `npx cap run android`.

Optional flags:

```powershell
powershell -ExecutionPolicy Bypass -File .\run-android-debug.ps1 -SkipBuild
powershell -ExecutionPolicy Bypass -File .\run-android-debug.ps1 -SkipCapRun
```

## Preflight Screen
On native app.debug launches, unauthenticated users are routed to `/preflight` before `/login`.

Checks shown:
1. API health (`/api/health/`)
2. WebSocket reachability (`/ws/steps/sync/`)

## Concurrent API Load Test
Script location: `backend/load_test_concurrent.py`

Example run:

```powershell
Set-Location .\backend
C:/Users/Admin/AppData/Local/Programs/Python/Python311/python.exe .\load_test_concurrent.py --base-url http://127.0.0.1:8000 --users 25 --loops 3
```

With chat endpoint stress (requires a private challenge id that users can access):

```powershell
C:/Users/Admin/AppData/Local/Programs/Python/Python311/python.exe .\load_test_concurrent.py --base-url http://127.0.0.1:8000 --users 25 --loops 3 --chat-challenge-id 12
```

Notes:
1. If `APP_SIGNING_SECRET` is set in env, signed sync headers are generated automatically.
2. The script creates unique usernames per run to avoid collisions and auto-deletes those users after completion.
3. Use `--no-cleanup` only when you intentionally want to inspect generated users after the run.
4. Keep `--sync-delay` at or above `1.0` seconds to respect server anti-spam sync guardrails.
