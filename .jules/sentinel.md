## 2026-05-24 - [UnboundLocalError and Race Condition in join_challenge]
**Vulnerability:** A variable `user` was accessed in a balance check before being defined, leading to an `UnboundLocalError`. Additionally, the user record was being locked too late in the transaction, creating a potential race condition for concurrent challenge joins.
**Learning:** High-concurrency financial operations must resolve and lock participating entities (like users and challenges) at the very beginning of the database transaction to ensure consistent state and prevent `UnboundLocalError` when logic branches skip the later definition.
**Prevention:** Always use `select_for_update()` on all involved accounts at the start of any transaction that performs balance-dependent checks.

## 2026-05-24 - [Stored XSS in Challenge Chat]
**Vulnerability:** User-provided chat messages were saved directly to the database without sanitization, allowing for Stored XSS attacks.
**Learning:** Even if the frontend performs some escaping, the backend must enforce strict sanitization (using libraries like `bleach`) before persistence to provide defense-in-depth and protect all potential consumers of the data.
**Prevention:** Mandatory use of `sanitize_chat_message` or similar utilities for all user-supplied text fields in DRF views.
