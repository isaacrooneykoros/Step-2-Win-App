## 2026-06-17 - [Stored XSS in Support & Admin Actions]
**Vulnerability:** User and Admin supplied text fields (support replies, rejection reasons, admin notes) were not sanitized before being stored and displayed, leading to Stored XSS.
**Learning:** Even internal admin-facing tools can be vectors for XSS if they display unsanitized user input or if admins themselves can inject scripts that target other admins.
**Prevention:** Always apply `sanitize_text` to any free-text input field before database persistence, regardless of whether it's user-facing or admin-facing.

## 2026-06-17 - [Race Condition in Challenge Joining]
**Vulnerability:** A potential race condition existed in `join_challenge` where balance checks and deductions could be circumvented by rapid concurrent requests.
**Learning:** Business logic involving financial balances must be protected by database-level locks (`select_for_update`) within an atomic transaction. An `UnboundLocalError` was also discovered where the `user` object was referenced before being fetched and locked.
**Prevention:** Always fetch and lock the `User` object at the start of a transaction involving balance changes.
