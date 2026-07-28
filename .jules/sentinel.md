## 2026-07-28 - Race Condition / TOCTOU Double Spend in Challenges
**Vulnerability:** User balance validation and locked balance percentages were checked outside of atomic locking, or referencing `user` before assignment (throwing an `UnboundLocalError`). This created Time-of-Check to Time-of-Use (TOCTOU) race conditions allowing double spending.
**Learning:** Checking balances and limits outside of `select_for_update` allows concurrent requests to slip past validations before database state is mutated and committed.
**Prevention:** Always lock the `user` object using `select_for_update()` at the very beginning of the `transaction.atomic()` block before validating any balances, entry fees, or locked limits.
