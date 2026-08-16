## 2026-08-16 - User Locking Order in Atomic Challenge Transactions
**Vulnerability:** In `join_challenge`, user balance and locked limit checks referenced `user` before `user = request.user.__class__.objects.select_for_update().get(...)`, causing `UnboundLocalError` and race conditions during concurrent challenge entry.
**Learning:** Balance checks and limit evaluations must happen on the row-locked user object inside `transaction.atomic()` to ensure atomic verification.
**Prevention:** Always acquire `select_for_update()` lock on the user model at the top of the `transaction.atomic()` block before evaluating `available_balance` or `locked_balance`.
