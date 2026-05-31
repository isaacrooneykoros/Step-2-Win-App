# Sentinel Security Journal

## 2026-05-31 - [Race Condition in Challenge Joining Logic]
**Vulnerability:** A race condition in `join_challenge`, `create_challenge`, and `rematch_challenge` allowed users to potentially join multiple challenges concurrently or bypass balance checks due to late locking of the `user` object. Additionally, an `UnboundLocalError` occurred when balance checks were attempted before the `user` variable was assigned.
**Learning:** In Django views involving balance updates, it is critical to perform `select_for_update()` at the very beginning of the `transaction.atomic()` block before any business logic or balance checks are executed.
**Prevention:** Always follow the "Lock then Check" pattern for financial operations. Fetch the user with `select_for_update()` as the first action inside the transaction.

## 2026-05-31 - [Stored XSS in Chat and Support Tickets]
**Vulnerability:** User-supplied text in challenge chat messages and support ticket replies was saved directly to the database without sanitization, leading to Stored XSS risks if displayed unsafely in admin or user interfaces.
**Learning:** Even if the frontend performs sanitization, the backend must enforce it before persistence as a second layer of defense (Defense in Depth).
**Prevention:** Use `sanitize_text` or `sanitize_chat_message` from `apps.core.sanitizers` for all user-contributed text fields before saving.
