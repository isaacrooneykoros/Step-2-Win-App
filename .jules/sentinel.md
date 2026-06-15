## 2026-06-15 - [Concurrency & XSS Protection]
**Vulnerability:** Race condition in `join_challenge` and Stored XSS in admin/support views.
**Learning:** Initial check-then-act logic in `join_challenge` was vulnerable to balance bypass via concurrent requests because the user object was not locked. Admin views were displaying unsanitized user-supplied reasons and notes.
**Prevention:** Always use `select_for_update()` inside a `transaction.atomic()` block for balance-sensitive operations. Explicitly sanitize all user-supplied text displayed in administrative interfaces using `sanitize_text`.
