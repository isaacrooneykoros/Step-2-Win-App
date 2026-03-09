# Step2Win Anti-Cheat System - Deployment Guide

## 1. Environment Variables Setup

### APP_SIGNING_SECRET Configuration

The `APP_SIGNING_SECRET` is critical for HMAC request signing validation. It must be set in all environments.

#### For Staging Environment

Create `.env.staging` in the `backend/` directory:

```bash
# Django Core
SECRET_KEY=your-django-secret-key-staging
DEBUG=False
ALLOWED_HOSTS=staging.yourdomain.com,api.staging.yourdomain.com

# Anti-Cheat Signing
APP_SIGNING_SECRET=staging-secret-key-min-32-characters-recommended

# Redis (for idempotency)
USE_REDIS=True
REDIS_URL=redis://staging-redis-server:6379/0

# Celery
CELERY_BROKER_URL=redis://staging-redis-server:6379/1
CELERY_RESULT_BACKEND=redis://staging-redis-server:6379/2
```

#### For Production Environment

Create `.env.production` in the `backend/` directory:

```bash
# Django Core
SECRET_KEY=your-production-secret-key-generate-with-secrets.token_urlsafe()
DEBUG=False
ALLOWED_HOSTS=yourdomain.com,api.yourdomain.com,www.yourdomain.com

# Anti-Cheat Signing - USE A STRONG CRYPTOGRAPHICALLY RANDOM SECRET
# Generate with: python -c "import secrets; print(secrets.token_urlsafe(32))"
APP_SIGNING_SECRET=<generate-strong-random-secret>

# Redis (production cluster)
USE_REDIS=True
REDIS_URL=redis://prod-redis-cluster:6379/0

# Celery
CELERY_BROKER_URL=redis://prod-redis-cluster:6379/1
CELERY_RESULT_BACKEND=redis://prod-redis-cluster:6379/2

# Enable optional security features
ENABLE_DEFENDER=True
```

### Generating Strong Secrets

```bash
# For APP_SIGNING_SECRET
python -c "import secrets; print('APP_SIGNING_SECRET=' + secrets.token_urlsafe(32))"

# For Django SECRET_KEY
python -c "from django.core.management.utils import get_random_secret_key; print('SECRET_KEY=' + get_random_secret_key())"
```

**IMPORTANT:** Never commit `.env.production` to version control. Use your hosting platform's secret management (AWS Secrets Manager, GCP Secret Manager, Azure Key Vault, Heroku Config Vars, etc.).

---

## 2. Deployment Steps

### Step 1: Verify Migrations Pending

```bash
cd backend
python manage.py showmigrations steps
```

Expected output:
```
steps
 [X] 0001_initial
 [X] 0002_...
 [X] 0003_...
 [ ] 0004_trustscore_fraudflag  ← Should be pending
```

### Step 2: Apply Migrations

```bash
python manage.py migrate
```

Expected output:
```
Running migrations:
  Applying steps.0004_trustscore_fraudflag... OK
```

### Step 3: Verify System Health

```bash
python manage.py check
```

Expected: `System check identified no issues (0 silenced).`

### Step 4: Collect Static Files (Production Only)

```bash
python manage.py collectstatic --noinput
```

### Step 5: Create Superuser for Admin Access (if needed)

```bash
python manage.py createsuperuser
```

---

## 3. Mobile App Configuration

### Frontend HMAC Secret Sharing

The mobile app (step2win-web) needs the **SAME** `APP_SIGNING_SECRET` value as the backend.

#### Update `.env` in `step2win-web/`:

```bash
VITE_APP_SIGNING_SECRET=<same-value-as-backend-APP_SIGNING_SECRET>
```

**Important:** 
- This secret will be embedded in the compiled app; it's client-side and not critical like server secrets
- Both staging and production apps must match their respective backend secrets
- Update during build time, not runtime

---

## 4. Testing Signed Sync Requests

### Option A: Manual Test with Python

```bash
cd backend
python test_signed_sync.py
```

This script:
- Creates a test user with profile
- Generates HMAC signature (X-App-Signature header)
- Submits sync with proper headers
- Verifies response contains trust_score/trust_status

### Option B: Mobile App QA Test

1. **Staging App:** Build with staging APP_SIGNING_SECRET and point to staging API
2. **Sync Health Data:** Submit steps from mobile app
3. **Verify Response:**
   - Should receive 200 OK (if no fraud flags)
   - Response includes `approved_steps`, `trust_score`, `trust_status`
4. **Check Admin Panel:** View submitted data at `api.staging/admin/fraud/`

### Option C: Postman/Insomnia Test

Manually construct request:

```
POST /api/steps/sync/
Headers:
  X-App-Signature: <HMAC-SHA256 of body>
  X-Timestamp: <current-unix-seconds>
  X-Idempotency-Key: <uuid-v4>
  Authorization: Bearer <jwt-token>

Body (JSON):
{
  "steps": 8500,
  "date": "2026-03-07",
  "distance_km": 5.2,
  "calories": 425,
  "active_minutes": 45
}
```

Use this Python helper:

```python
import hmac
import hashlib
import json
import uuid
from datetime import datetime

SECRET = "your-APP_SIGNING_SECRET"
body = json.dumps({"steps": 8500, "date": "2026-03-07", "distance_km": 5.2, "calories": 425, "active_minutes": 45})
timestamp = str(int(datetime.now().timestamp()))
body_sha = hashlib.sha256(body.encode()).hexdigest()

msg = f"{user_id}:{timestamp}:{body_sha}"
sig = hmac.new(SECRET.encode(), msg.encode(), hashlib.sha256).hexdigest()

print(f"X-App-Signature: {sig}")
print(f"X-Timestamp: {timestamp}")
print(f"X-Idempotency-Key: {uuid.uuid4()}")
```

---

## 5. Monitoring Nightly Fraud Scan

### Task Details

- **Schedule:** Daily @ 2:00 AM UTC (configurable in `CELERY_BEAT_SCHEDULE`)
- **Task Name:** `nightly_fraud_scan`
- **Duration:** Typically 5-30 seconds (depends on user count)
- **Checks:**
  - 14+ consecutive days with ≥40k steps (no rest days)
  - Weekly totals >420k steps

### Monitoring Approaches

#### 1. **Celery Logs**

View Celery task execution:

```bash
# If using persistent Celery logs
tail -f /var/log/celery/celery.log | grep nightly_fraud_scan

# Or in Docker
docker logs <celery-container> | grep nightly_fraud_scan
```

Expected log entries:
```
[2026-03-07 02:00:00.123456] nightly_fraud_scan: Starting nightly fraud scan...
[2026-03-07 02:00:05.654321] nightly_fraud_scan: Completed. Flagged 3 users for no_rest_days pattern.
```

#### 2. **Django Admin Panel**

`/admin/steps/fraudflag/`

Filter for recently created flags with `flag_type='no_rest_days'` or `'weekly_cap_exceeded'` and creation date = today.

#### 3. **Admin API Endpoint**

```bash
curl -H "Authorization: Bearer <admin-token>" \
  http://api.staging/api/admin/fraud/
```

Response includes:
```json
{
  "flags_today": 3,
  "recent_flags": [
    {
      "id": 42,
      "user_id": 7,
      "flag_type": "no_rest_days",
      "severity": "medium",
      "created_at": "2026-03-07T02:00:05Z",
      "reviewed": false
    }
  ]
}
```

#### 4. **Django Management Command (Manual Trigger)**

Test the task manually before 2 AM:

```bash
cd backend
python manage.py shell
>>> from apps.steps.tasks import nightly_fraud_scan
>>> nightly_fraud_scan.delay()  # Async
# or
>>> nightly_fraud_scan()  # Sync (for testing)
```

---

## 6. Configurable Detection Thresholds

All thresholds are defined in `backend/apps/steps/anti_cheat.py` (lines 14-30).

### Current Defaults

| Threshold | Value | Purpose |
|-----------|-------|---------|
| `DAILY_STEP_CAP` | 60,000 | Max steps per day; >100k = critical |
| `MAX_STEPS_PER_MINUTE` | 175 | Impossible acceleration threshold |
| `WEEKLY_HARD_CAP` | 420,000 | 7 × daily cap |
| `SPIKE_MULTIPLIER` | 5.0 | Personal avg spike detection (5× = high) |
| `MIN_HISTORY_DAYS` | 5 | Days of history required for spike calc |
| `PATTERN_CV_THRESHOLD` | 0.03 | Coefficient of variation (3%) for uniformity |
| `DISTANCE_KM_PER_STEP_MIN` | 0.0005 | Minimum ~50cm per step (device shaking) |
| `DISTANCE_KM_PER_STEP_MAX` | 0.0018 | Maximum ~180cm per step (vehicle/GPS) |
| `CALORIE_PER_1000_STEPS_MIN` | 25 | Min 25 kcal/1000; lower = spoofing |
| `CALORIE_PER_1000_STEPS_MAX` | 100 | Max 100 kcal/1000; higher = impossible |
| `BACKDATING_DAYS_ALLOWED` | 1 | Only today/yesterday allowed |
| `LATE_NIGHT_HOUR_START` | 1 AM | Overnight bulk detection window |
| `LATE_NIGHT_HOUR_END` | 5 AM |  |
| `LATE_NIGHT_BULK_THRESHOLD` | 20,000 | >20k steps 1–5 AM = suspicious |

### Tuning Recommendations

**If too many false positives:**
- ↑ `DAILY_STEP_CAP` (e.g., 75,000)
- ↓ `SPIKE_MULTIPLIER` (e.g., 7.0)
- ↑ `CALORIE_PER_1000_STEPS_MAX` (e.g., 120)

**If missing obvious cheaters:**
- ↓ `DAILY_STEP_CAP` (e.g., 50,000)
- ↑ `SPIKE_MULTIPLIER` (e.g., 3.0)
- ↓ `CALORIE_PER_1000_STEPS_MIN` (e.g., 20)
- Reduce `PATTERN_CV_THRESHOLD` (e.g., 0.02)

### How to Update Thresholds

Edit `backend/apps/steps/anti_cheat.py` lines 14-30:

```python
# Example: Lower daily cap to 50k to catch more cheaters
DAILY_STEP_CAP = 50_000

# Example: Increase spike multiplier to 7x to reduce false positives
SPIKE_MULTIPLIER = 7.0
```

**No migration needed** — these are runtime constants, not database fields.

---

## 7. Verification Checklist

- [ ] `.env.staging` created with `APP_SIGNING_SECRET`
- [ ] `.env.production` created with strong random `APP_SIGNING_SECRET` (not in git)
- [ ] Migrations applied: `python manage.py migrate` succeeds
- [ ] System check passes: `python manage.py check`
- [ ] Test signed sync: `python test_signed_sync.py` succeeds
- [ ] Mobile app configured with same `VITE_APP_SIGNING_SECRET`
- [ ] Celery Beat task scheduled (verify in Django admin `django_celery_beat.PeriodicTask`)
- [ ] First nightly run monitored @ 2 AM (check logs)
- [ ] Admin panel accessible at `/admin/fraud/`
- [ ] Admin API endpoint responds: `GET /api/admin/fraud/`

---

## 8. Rollback Plan

If issues arise:

```bash
# Rollback migration
python manage.py migrate steps 0003

# Remove FraudFlag and TrustScore data
python manage.py shell
>>> from apps.steps.models import FraudFlag, TrustScore
>>> FraudFlag.objects.all().delete()
>>> TrustScore.objects.all().delete()

# Revert anti-cheat changes in sync_health view
# (keep backup of original before deployment)
```

---

## 9. Support & Debugging

### Common Issues

**"Signature mismatch" errors in logs**
- Verify `APP_SIGNING_SECRET` matches on frontend and backend
- Check clock sync (>5 min difference = rejection)
- Ensure request body JSON not modified in transit

**Celery task not running @ 2 AM**
- Verify Redis connectivity: `redis-cli ping` → PONG
- Check `CELERY_BEAT_SCHEDULE` in settings.py
- Restart Celery Beat: `celery -A step2win beat --loglevel=debug`

**False positive flag storms**
- Check logs for pattern; adjust thresholds per "Tuning Recommendations"
- Review recent users' legitimate high-step days
- Run `nightly_fraud_scan` manually in dev to test threshold changes

### Quick Debug Commands

```bash
# Check if Redis is running
redis-cli ping

# View all pending Celery tasks
celery -A step2win inspect active

# View Celery Beat schedule
celery -A step2win inspect scheduled

# Manually run fraud scan (once)
python manage.py shell
>>> from apps.steps.tasks import nightly_fraud_scan
>>> nightly_fraud_scan()
```

---

## Contact & Escalation

For questions or issues, refer to:
- Anti-cheat engine code: `backend/apps/steps/anti_cheat.py`
- Models: `backend/apps/steps/models.py`
- Middleware: `backend/apps/steps/middleware.py`
- Admin API: `backend/apps/admin_api/views.py`
