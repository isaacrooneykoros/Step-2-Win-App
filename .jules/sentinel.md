# Sentinel Security Journal

## 2026-08-06 - [Atomic Lock Concurrency Race Condition in join_challenge]
**Vulnerability:** A race condition exists in `join_challenge` where validation checks (such as maximum locked balance and already-joined validation) were executed before the User object was locked with `select_for_update()`. This allowed concurrent requests from the same user to bypass entry limit checks and balance constraints, leading to a potential "double-join" or balance over-locking vulnerability.
**Learning:** Performing security validations on mutable user profiles (e.g., wallet balance, active challenges) outside of a locked scope is unsafe, as successive concurrent threads can read stale pre-transaction data.
**Prevention:** Always place the `select_for_update()` lock on critical parent objects (such as the User profile) immediately upon entering the `transaction.atomic()` block, and before performing any validations or model mutations on those objects.
