# Sentinel Security Journal

## 2026-06-19 - Stored XSS in Communication Channels
**Vulnerability:** User-supplied text in challenge chats, support tickets, and administrative notes was persisted without sanitization.
**Learning:** While the frontend might escape data, Stored XSS can still target administrators or other users if the API does not enforce sanitization at the boundary. The codebase has a centralized `apps.core.sanitizers` but it was not consistently applied to all text fields.
**Prevention:** Always apply `sanitize_text` or `sanitize_chat_message` in the view or serializer before calling `.save()`.

## 2026-06-19 - Atomic Balance Race Conditions
**Vulnerability:** Entry fee deductions and balance checks were sometimes performed before locking the User object.
**Learning:** In high-concurrency environments like fitness challenges, race conditions can lead to double-spending or negative balances.
**Prevention:** Use `select_for_update()` at the very start of a `transaction.atomic()` block for any object involved in financial calculations.
