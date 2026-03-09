# Nightly Fraud Scan Monitoring & Detection Threshold Tuning

## 1. Nightly Fraud Scan - How It Works

### Background Task

The `nightly_fraud_scan` task runs daily at **2:00 AM UTC** (configurable) and performs pattern-based fraud detection across all users who have been active in the past 14 days.

**Location:** [backend/apps/steps/tasks.py](backend/apps/steps/tasks.py)

### What It Detects

The task checks two primary patterns that sync-time anti-cheat misses:

1. **No Rest Days Pattern** (14-day window)
   - Detects users with ≥14 consecutive days where each day has ≥40k steps
   - Indicates potential bot/device manipulation
   - **Severity:** Medium
   - **Flag Type:** `no_rest_days`

2. **Weekly Cap Exceeded** (7-day rolling)
   - Detects users with weekly totals >420k steps (7 × 60k daily cap)
   - Indicates systematic over-submission
   - **Severity:** High
   - **Flag Type:** `weekly_cap_exceeded`

### Task Flow

```
2:00 AM UTC → Celery Beat triggers task
  ↓
For each active user (last 14 days):
  ├─ Check for 14+ consecutive 40k+ days → Creates `no_rest_days` flag
  └─ Check for week totals >420k → Creates `weekly_cap_exceeded` flag
  ↓
Update user TrustScore (deduct penalty points)
  ↓
Admins notified via Admin API `/api/admin/fraud/`
```

---

## 2. Monitoring the Nightly Task

### Real-Time Monitoring

#### 2.1 Django Admin Panel

**URL:** `{your-domain}/admin/steps/fraudflag/`

```
Filters:
- Created date = Today (or last 48 hours)
- Flag type = "no_rest_days" OR "weekly_cap_exceeded"
- Reviewed = False
```

**Example Query:**
```django
from apps.steps.models import FraudFlag
from datetime import timedelta
from django.utils import timezone

today = timezone.now().date()
flags_today = FraudFlag.objects.filter(
    created_at__date__gte=today - timedelta(days=1),
    flag_type__in=['no_rest_days', 'weekly_cap_exceeded'],
    reviewed=False
)

print(f"Flagged users today: {flags_today.count()}")
for flag in flags_today:
    print(f"  - User {flag.user_id}: {flag.flag_type} (severity: {flag.severity})")
```

#### 2.2 Celery Monitoring

**Check Task Execution:**

```bash
# Access Celery shell
python manage.py shell
>>> from apps.steps.tasks import nightly_fraud_scan
>>> result = nightly_fraud_scan.delay()
>>> result.status  # 'PENDING', 'STARTED', 'SUCCESS', 'FAILURE'
>>> result.result
```

**View Task Logs:**

```bash
# If using Celery workers with logging
tail -f /var/log/celery/celery.log | grep nightly_fraud_scan

# Docker Compose
docker logs {celery-worker-container} | grep nightly_fraud_scan
```

**Expected Log Output:**
```
[2026-03-07 02:00:00.123456] apps.steps.tasks.nightly_fraud_scan: Starting nightly fraud scan...
[2026-03-07 02:00:05.654321] apps.steps.tasks.nightly_fraud_scan: Scanned 2,450 active users
[2026-03-07 02:00:07.987654] apps.steps.tasks.nightly_fraud_scan: Created 3 no_rest_days flags, 2 weekly_cap_exceeded flags
[2026-03-07 02:00:09.111111] apps.steps.tasks.nightly_fraud_scan: Completed successfully
```

#### 2.3 Admin API Endpoint

**Check Flags via API:**

```bash
curl -H "Authorization: Bearer {TOKEN}" \
  http://{api-domain}/api/admin/fraud/
```

**Response:**
```json
{
  "flags_today": 5,
  "open_flags": 42,
  "critical_unread": 2,
  "high_unread": 8,
  "restricted_users": 3,
  "suspended_users": 1,
  "banned_users": 0,
  "recent_flags": [
    {
      "id": 89,
      "user_id": 2145,
      "flag_type": "no_rest_days",
      "severity": "medium",
      "created_at": "2026-03-07T02:00:07Z",
      "reviewed": false,
      "details": {
        "consecutive_days": 14,
        "daily_average": 52400
      }
    },
    {
      "id": 90,
      "user_id": 2146,
      "flag_type": "weekly_cap_exceeded",
      "severity": "high",
      "created_at": "2026-03-07T02:00:08Z",
      "reviewed": false,
      "details": {
        "week_starting": "2026-03-01",
        "total_steps": 438500
      }
    }
  ]
}
```

#### 2.4 Scheduled Task Status (Django admin)

**URL:** `{your-domain}/admin/django_celery_beat/periodictask/`

**Verify Entry:**
- Task name: `nightly_fraud_scan`
- Task path: `apps.steps.tasks.nightly_fraud_scan`
- Schedule: Crontab (0 2 * * * UTC)
- Status: Enabled ✓

---

## 3. Detection Thresholds & Tuning

### Current Thresholds

All thresholds are hardcoded in [backend/apps/steps/anti_cheat.py](backend/apps/steps/anti_cheat.py):

| Setting | Value | Purpose | Tuning Factor |
|---------|-------|---------|---|
| `DAILY_STEP_CAP` | 60,000 | Max steps per day; >100k triggers critical | Increase to reduce FP |
| `MAX_STEPS_PER_MINUTE` | 175 | Impossible acceleration (impossible_rate check) | Increase for slower devices |
| `WEEKLY_HARD_CAP` | 420,000 | 7 × daily cap | Must equal 7 × DAILY_STEP_CAP |
| `SPIKE_MULTIPLIER` | 5.0 | Personal average spike factor | Increase tolerance for spikes |
| `MIN_HISTORY_DAYS` | 5 | Days required for spike calc | Reduce for new users |
| `PATTERN_CV_THRESHOLD` | 0.03 | Coefficient of variation (3%) for uniform pattern | Increase to reduce FP |
| `DISTANCE_KM_PER_STEP_MIN` | 0.0005 | Min ~50cm per step | Decrease for short-legged users |
| `DISTANCE_KM_PER_STEP_MAX` | 0.0018 | Max ~180cm per step | Increase to allow taller users |
| `CALORIE_PER_1000_STEPS_MIN` | 25 | Min kcal efficiency | Decrease for lightweight users |
| `CALORIE_PER_1000_STEPS_MAX` | 100 | Max kcal efficiency | Increase for overweight users |
| `BACKDATING_DAYS_ALLOWED` | 1 | Only today/yesterday | Keep strict (security) |
| `LATE_NIGHT_BULK_THRESHOLD` | 20,000 | >20k steps 1–5 AM | Increase for night shift workers |

### Real-World Tuning Scenarios

#### Scenario 1: Too Many False Positives

**Symptoms:**
- Legitimate athletes flagged for "impossible_rate"
- Elderly/children flagged for "distance_ratio"
- Obese users flagged for "calorie_ratio"

**Tuning Action:**

```python
# backend/apps/steps/anti_cheat.py

# ↑ Increase
MAX_STEPS_PER_MINUTE = 200  # from 175 (allows faster walking)

DISTANCE_KM_PER_STEP_MAX = 0.0020  # from 0.0018 (allow taller users)
DISTANCE_KM_PER_STEP_MIN = 0.0004  # from 0.0005 (allow shorter strides)

CALORIE_PER_1000_STEPS_MAX = 120  # from 100 (overweight users burn more)
CALORIE_PER_1000_STEPS_MIN = 20   # from 25 (lightweight users burn less)

SPIKE_MULTIPLIER = 7.0  # from 5.0 (reduce spike detector sensitivity)

PATTERN_CV_THRESHOLD = 0.05  # from 0.03 (allow more variation)

# No migration needed; restart backend
```

#### Scenario 2: Catching More Cheaters

**Symptoms:**
- Cheaters slipping through with fake data
- Suspected bots not being flagged
- Need stricter enforcement

**Tuning Action:**

```python
# ↓ Decrease thresholds

DAILY_STEP_CAP = 50_000  # from 60,000 (stricter daily limit)

SPIKE_MULTIPLIER = 3.5  # from 5.0 (catch smaller anomalies)

PATTERN_CV_THRESHOLD = 0.02  # from 0.03 (stricter uniformity check)

LATE_NIGHT_BULK_THRESHOLD = 15_000  # from 20,000 (catch smaller overnight dumps)

CALORIE_PER_1000_STEPS_MIN = 30  # from 25 (stricter calorie check)
```

#### Scenario 3: Tuning for Specific Demographics

**For Marathon Athletes:**
```python
# They legitimately submit 100k+ steps on race days
DAILY_STEP_CAP = 75_000  # from 60,000
SPIKE_MULTIPLIER = 8.0   # from 5.0 (allow massive single-day events)
```

**For Elderly Users (>65):**
```python
# Lower distance ratios and calorie burn rates
DISTANCE_KM_PER_STEP_MIN = 0.0003    # from 0.0005 (shorter stride)
DISTANCE_KM_PER_STEP_MAX = 0.0015    # from 0.0018

CALORIE_PER_1000_STEPS_MIN = 15      # from 25 (less energy)
CALORIE_PER_1000_STEPS_MAX = 60      # from 100
```

**For Night Shift Workers:**
```python
# Allow high step counts in 1-5 AM window
LATE_NIGHT_BULK_THRESHOLD = 30_000   # from 20,000
```

---

## 4. Deployment Steps for Threshold Changes

### Quick Update (No Migration)

1. **Edit thresholds:**
   ```bash
   vim backend/apps/steps/anti_cheat.py
   # Update DAILY_STEP_CAP, SPIKE_MULTIPLIER, etc.
   ```

2. **Restart Django/Celery:**
   ```bash
   # Local development
   pkill -f "runserver"
   python manage.py runserver

   # Production (Gunicorn + Celery)
   systemctl restart gunicorn
   celery -A step2win worker --loglevel=info
   ```

3. **Test with existing data:**
   ```bash
   python manage.py shell
   >>> from apps.steps.anti_cheat import run_anti_cheat
   >>> from apps.users .models import User
   >>> user = User.objects.first()
   >>> result = run_anti_cheat(user, steps=75000, date='2026-03-07')
   >>> print(f"Flags raised: {result.flags}")
   >>> print(f"Approved steps: {result.approved_steps}")
   ```

4. **Verify no errors:**
   ```bash
   python manage.py check
   # Clean Django system check passes
   ```

### Optional: Configuration Table (Future)

For future reference, consider moving thresholds to a database table for runtime tuning without restarts:

```python
# backend/apps/steps/models.py

class AntiCheatConfig(models.Model):
    """Configuration for anti-cheat thresholds. Singleton pattern."""
    daily_step_cap = models.IntegerField(default=60_000)
    max_steps_per_minute = models.IntegerField(default=175)
    weekly_hard_cap = models.IntegerField(default=420_000)
    spike_multiplier = models.FloatField(default=5.0)
    # ...etc
    
    class Meta:
        verbose_name_plural = "Anti-Cheat Config"
    
    def save(self, *args, **kwargs):
        self.pk = 1  # Enforce singleton
        super().save(*args, **kwargs)

# Usage:
from apps.steps.models import AntiCheatConfig
config = AntiCheatConfig.objects.first()
DAILY_STEP_CAP = config.daily_step_cap  # Reads from DB
```

---

## 5. Monitoring Checklist

Daily task queue:

- [ ] **2 AM UTC:** Verify `nightly_fraud_scan` task completes
- [ ] **2:15 AM UTC:** Check Admin panel for `no_rest_days` or `weekly_cap_exceeded` flags
- [ ] **Daily:** Review new unreviewed flags in `/admin/fraud/`
- [ ] **Weekly:** Analyze false positive rate (ratio of dismissed flags to actioned flags)
- [ ] **Monthly:** Evaluate threshold effectiveness; adjust if >30% FP or <5% true positives

---

## 6. Common Issues & Troubleshooting

### Issue: Task doesn't run at 2 AM

**Diagnosis:**
```bash
# Check if Celery Beat is running
ps aux | grep celery

# Verify task is scheduled
python manage.py shell
>>> from django_celery_beat.models import PeriodicTask
>>> PeriodicTask.objects.filter(name='nightly-fraud-scan')
<QuerySet [<PeriodicTask: nightly-fraud-scan>]>
```

**Fix:**
```bash
# Restart Celery Beat
celery -A step2win beat --loglevel=info
```

### Issue: Too many false positives after deploying

**Diagnosis:**
```bash
# Count dismissed vs actioned recent flags
from apps.steps.models import FraudFlag
dismissed = FraudFlag.objects.filter(
    actioned=True,
    action='dismiss',
    created_at__gte=timezone.now() - timedelta(days=7)
).count()
actioned = FraudFlag.objects.filter(
    actioned=True,
    action__in=['restrict', 'suspend', 'ban'],
    created_at__gte=timezone.now() - timedelta(days=7)
).count()
print(f"FP Rate: {dismissed / (dismissed + actioned):.1%}")
```

**Fix:** Increase relevant thresholds per "Tuning for False Positives" section above.

### Issue: Cheaters not being caught

**Diagnosis:**
```bash
# Find high-step submitters flagged < 5 times in past 30 days
from apps.steps.models import HealthRecord, FraudFlag
from django.db.models import Sum
from datetime import timedelta

high_steppers = HealthRecord.objects.filter(
    created_at__gte=timezone.now() - timedelta(days=30)
).values('user').annotate(
    total=Sum('steps')
).filter(
    total__gt=2_100_000  # 30 days × 70k average = suspicious
)

for record in high_steppers:
    user_id = record['user']
    flag_count = FraudFlag.objects.filter(
        user_id=user_id,
        created_at__gte=timezone.now() - timedelta(days=30)
    ).count()
    if flag_count < 2:
        print(f"User {user_id}: {record['total']} steps, only {flag_count} flags")
```

**Fix:** Decrease relevant thresholds per "Tuning for Cheater Catch Rate" section above.

---

## 7. References

- [Anti-Cheat Engine Code](backend/apps/steps/anti_cheat.py)
- [Nightly Task Code](backend/apps/steps/tasks.py)
- [Admin API Endpoints](backend/apps/admin_api/views.py)
- [Celery Beat Schedule](backend/step2win/celery.py)
