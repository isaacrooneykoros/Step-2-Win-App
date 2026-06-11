## 2026-06-11 - [Race Condition in Challenge Creation/Joining]
**Vulnerability:** A race condition allowed users to bypass balance checks by firing multiple concurrent requests. The balance check was performed before locking the user object in the database.
**Learning:** Atomic transactions alone are not enough to prevent race conditions if the read (balance check) and write (balance deduction) are not protected by a database-level lock (`select_for_update`).
**Prevention:** Always use `select_for_update()` to lock critical objects (like User for balance) at the very beginning of a `transaction.atomic()` block before any validation logic is performed.

## 2026-06-11 - [Stored XSS in Challenge Chat]
**Vulnerability:** The challenge chat REST API and historical message retrieval were not sanitizing user-supplied content, allowing for Stored XSS.
**Learning:** While WebSocket consumers were already sanitizing input, the REST API endpoints provided a bypass. Defensive programming requires sanitizing at every entry and exit point for user-supplied HTML.
**Prevention:** Use a dedicated sanitization utility (like `bleach`) for all user-supplied text fields before persistence and upon retrieval. In this project, `sanitize_chat_message` should be consistently applied to chat content.
