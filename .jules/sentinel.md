# Sentinel's Journal - Security Learnings

## 2026-08-12 - Atomic Locking for Wallet and Challenge Actions
**Vulnerability:** Race conditions on wallet and challenge registrations, where available balance and locked balance limits were checked outside or before locking the user via `select_for_update()`, potentially leading to double-spending or exceeding the `MAX_LOCKED_BALANCE_PERCENT` limit under concurrent workloads. Also caused `UnboundLocalError` in `join_challenge` due to referencing a local variable before it was fetched inside the atomic block.
**Learning:** Checking business limits and balances must be done *after* acquiring a pessimistic lock (`select_for_update()`) inside an atomic transaction. Doing so ensures that the current state used for validation represents the source of truth, and no concurrent transaction can alter the state during validation and deduction.
**Prevention:** Always acquire the lock with `select_for_update()` at the very beginning of the `transaction.atomic()` block, and perform all security checks (available balance, locked percentage limits) immediately after the lock is acquired.
