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

## Wallet & Payment System Debugging

### Balance Consistency Issues

If users report stuck funds or unexpected balance states:

#### 1. Check for Invalid Balances
```sql
-- Find users with impossible balance states
SELECT user_id, username, wallet_balance, locked_balance 
FROM users_user 
WHERE locked_balance > wallet_balance
LIMIT 20;
```

If found, the nightly consistency check task will auto-fix these. Force run:
```bash
cd backend
python manage.py shell
>>> from apps.users.tasks import check_wallet_balance_consistency
>>> result = check_wallet_balance_consistency()
>>> print(result)
```

#### 2. Check for Orphaned Locked Balances
```sql
-- Users with locked funds but no active challenges
SELECT u.user_id, u.username, u.locked_balance, COUNT(p.id) as active_challenges
FROM users_user u
LEFT JOIN challenges_participant p ON u.user_id = p.user_id 
  AND p.challenge_id IN (SELECT id FROM challenges_challenge WHERE status='active')
WHERE u.locked_balance > 0
GROUP BY u.user_id
HAVING COUNT(p.id) = 0;
```

Auto-fixed by nightly task, or manually run the consistency check above.

#### 4. Audit Unexpected Wallet Funding (No Top-Up)
```bash
cd backend
python manage.py audit_wallet_funding --strict-topup-only
```

This flags users with positive `wallet_balance` but no completed deposit transaction.

#### 5. Safe Remediation (Dry-Run First)
```bash
cd backend

# Dry-run (recommended first)
python manage.py remediate_wallet_funding

# Apply changes after review
python manage.py remediate_wallet_funding --apply

# Optional: limit number of affected users in apply mode
python manage.py remediate_wallet_funding --apply --limit 10
```

Guardrails in remediation:
- Only users with `wallet_balance > 0` and zero completed deposits are considered
- Users with payout/refund credit history are skipped
- Users with `locked_balance > 0` are skipped

#### 3. Verify Payment ↔ Wallet Transaction Linking
```sql
-- Find completed payments without linked wallet transactions
SELECT pt.id, pt.order_id, pt.user_id
FROM payments_paymenttransaction pt
WHERE pt.status = 'completed' 
AND pt.type = 'deposit'
AND pt.wallet_transaction_id IS NULL
LIMIT 20;
```

**Action**: Unprocessed callbacks detected. Run reconciliation:
```bash
cd backend
python manage.py shell
>>> from apps.payments.tasks import process_unprocessed_payments
>>> process_unprocessed_payments()
```

### Challenge Issues

#### Cancel a Challenge (Release Locked Balances)
```bash
cd backend
python manage.py shell
>>> from apps.challenges.models import Challenge
>>> from apps.challenges.services import cancel_challenge
>>> challenge = Challenge.objects.get(id=123)  # Replace 123 with challenge ID
>>> cancel_challenge(challenge, reason='Admin cancelled - test')
```

Result: All participants get full refunds, locked_balance released automatically.

#### Check Challenge Payouts
```sql
-- View final payouts for a completed challenge
SELECT 
  u.username, 
  cr.final_rank,
  cr.payout_kes,
  cr.payout_method,
  cr.tiebreaker_label
FROM challenges_challengeresult cr
JOIN users_user u ON cr.user_id = u.id
WHERE cr.challenge_id = 123
ORDER BY cr.final_rank;
```

#### Verify Platform Fee Tracking
```sql
-- Check revenue collected from challenges
SELECT 
  c.id as challenge_id,
  c.name,
  c.total_pool,
  (c.total_pool * 0.05) as expected_fee,
  pr.amount_kes as collected_fee,
  pr.collected_at
FROM challenges_challenge c
LEFT JOIN payments_platformrevenue pr ON c.id = pr.challenge_id
WHERE c.status = 'completed'
ORDER BY pr.collected_at DESC
LIMIT 10;
```

### Payment Gateway (IntaSend) Debugging

#### Check Pending Payments
```sql
-- Find transactions still waiting for M-Pesa confirmation
SELECT 
  id, user_id, type, amount_kes, status, order_id, created_at,
  DATE_ADD(created_at, INTERVAL 15 MINUTE) as stale_check_time
FROM payments_paymenttransaction
WHERE status = 'pending'
AND created_at > NOW() - INTERVAL 1 HOUR
ORDER BY created_at;
```

#### Process Unprocessed Callbacks
Webhooks received but not processed get retried every 5 minutes by Celery. Force run:

```bash
cd backend
python manage.py shell
>>> from apps.payments.tasks import process_unprocessed_callbacks
>>> process_unprocessed_callbacks()
```

#### Manually Trigger Reconciliation
For payments older than 15 minutes in 'pending' status:

```bash
cd backend
python manage.py shell
>>> from apps.payments.tasks import reconcile_pending_payments
>>> reconcile_pending_payments()
```

### Withdrawal Debugging

#### Track Withdrawal Status
```sql
SELECT 
  id, user_id, amount_kes, method, status, 
  tracking_reference, fail_reason, created_at
FROM payments_withdrawalrequest
WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
ORDER BY created_at DESC;
```

#### Approve a Pending Withdrawal
```bash
cd backend
python manage.py shell
>>> from apps.payments.models import WithdrawalRequest
>>> from apps.payments.services import approve_withdrawal_and_send
>>> wr = WithdrawalRequest.objects.get(id='<uuid>')
>>> from django.contrib.auth import get_user_model
>>> admin_user = get_user_model().objects.filter(is_staff=True).first()
>>> approved, tracking_id = approve_withdrawal_and_send(wr, reviewer=admin_user)
>>> print(f"Approved, tracking ID: {tracking_id}")
```

#### Reject a Pending Withdrawal
```bash
cd backend
python manage.py shell
>>> from apps.payments.models import WithdrawalRequest
>>> from apps.payments.services import reject_withdrawal_request
>>> wr = WithdrawalRequest.objects.get(id='<uuid>')
>>> admin_user = get_user_model().objects.filter(is_staff=True).first()
>>> reject_withdrawal_request(wr, reason='Invalid account details', reviewer=admin_user)
```

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

## Celery Task Monitoring

### View All Scheduled Tasks
```bash
cd backend
python manage.py shell
>>> from django_celery_beat.models import PeriodicTask
>>> for task in PeriodicTask.objects.filter(enabled=True):
>>>     print(f"{task.name}: {task.task} @ {task.schedule}")
```

### All Wallet/Payment Tasks

| Task | Schedule | Purpose |
|------|----------|---------|
| `process-unprocessed-callbacks` | Every 5 min | Reprocess failed webhook callbacks |
| `monitor-new-non-topup-funded-accounts` | 2:20 AM daily | Alert on new accounts funded without top-ups |
| `check-wallet-balance-consistency` | 2:30 AM daily | Fix orphaned/invalid balances |
| `reconcile-pending-payments` | Every 30 min | Poll IntaSend for missed withdrawals |
| `nightly-fraud-scan` | 2:00 AM daily | Detect suspicious step patterns |
| `cleanup-inactive-sessions` | 3:00 AM daily | Remove old sessions |

### Run Task Manually
```bash
cd backend
python manage.py shell
>>> from apps.payments.tasks import process_unprocessed_callbacks
>>> result = process_unprocessed_callbacks()
>>> print(result)
```

Or via Celery directly:
```bash
celery -A step2win call apps.payments.tasks.process_unprocessed_callbacks
```

## Wallet Balance Rules

### User Balance Model
```
total_wallet = wallet_balance + locked_balance
available_balance = wallet_balance - locked_balance  # Can be < 0 (impossible state)
```

### Rules Enforced
1. ✅ No challenge join if `available_balance < entry_fee`
2. ✅ No challenge create if `available_balance < entry_fee`
3. ✅ Max lockable is 80% of `wallet_balance` (config: `MAX_LOCKED_BALANCE_PERCENT`)
4. ✅ Challenge entry deducts from `wallet_balance`, adds to `locked_balance`
5. ✅ Challenge completion releases from `locked_balance`
6. ✅ Challenge cancellation releases from `locked_balance` + refunds

### Invalid State Detection
Every 2:30 AM, the consistency check task verifies:
- No user has `locked_balance > wallet_balance`
- No user has orphaned locked balance with no active challenges
- All participants have correct locked amounts

## Quick Health Checks

### Is Everything Working?
```bash
cd backend

# 1. API health
curl http://127.0.0.1:8000/api/health/

# 2. Database connectivity
python manage.py dbshell  # Should connect without error

# 3. Celery tasks queued
celery -A step2win inspect active

# 4. Redis connectivity (if using Redis)
redis-cli ping  # Should return PONG

# 5. Check for stuck payments
python manage.py shell -c "
from django.utils import timezone
from datetime import timedelta
from apps.payments.models import PaymentTransaction
stuck = PaymentTransaction.objects.filter(
    status='pending',
    created_at__lt=timezone.now() - timedelta(hours=1)
)
print(f'Stuck payments: {stuck.count()}')
for txn in stuck[:5]:
    print(f'  - Order {txn.order_id}: {txn.amount_kes} KES')
"
```
