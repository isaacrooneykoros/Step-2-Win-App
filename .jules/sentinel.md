# Sentinel's Journal - Critical Learnings

## 2026-09-23 - Atomic Select for Update in Financial Cancellations
**Vulnerability:** In `cancel_withdrawal`, fetching model instances outside `db_transaction.atomic()` allows concurrent requests to evaluate initial status before acquiring database row locks, creating double-refund race conditions.
**Learning:** Checking model status prior to acquiring `select_for_update()` lock inside an atomic transaction allows stale state access under high concurrency.
**Prevention:** Perform `objects.select_for_update().get(...)` inside `db_transaction.atomic()` prior to validating state transitions in financial operations.
