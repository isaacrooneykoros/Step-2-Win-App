## 2026-09-22 - Concurrency Race Condition in Withdrawal Cancellation
**Vulnerability:** In `cancel_withdrawal`, fetching the `WithdrawalRequest` outside of the atomic lock permitted concurrent requests to both pass the `status == 'pending_review'` check before executing the refund transaction, leading to double-refunding of funds.
**Learning:** Checking status before obtaining row locks (`select_for_update`) within an atomic transaction creates a classic Time-of-Check to Time-of-Use (TOCTOU) race condition in financial operations.
**Prevention:** Always perform query lookups with `.select_for_update()` inside `db_transaction.atomic()` when status checks trigger monetary transactions or balance updates.
