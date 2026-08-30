## 2026-08-30 - Race Condition in Financial Rematch Logic
**Vulnerability:** Un-isolated wallet balance validation prior to entering `transaction.atomic()` allowed potential TOCTOU over-locking and over-spending race conditions on challenge rematches.
**Learning:** In Django views where user balances or locked funds are deducted, balance checks must happen INSIDE `transaction.atomic()` immediately following `select_for_update()` lock on the User model.
**Prevention:** Always lock user records with `select_for_update()` at the start of transaction blocks before evaluating `user.available_balance` or `MAX_LOCKED_BALANCE_PERCENT`.
