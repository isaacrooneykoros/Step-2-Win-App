# Sentinel's Security Journal 🛡️

## 2026-07-25 - [Stored XSS Protection on Support Ticket Replies]
**Vulnerability:** User and admin-facing support ticket replies were accepting arbitrary text input and saving/displaying them without any sanitization or length limits, exposing both users and administrators to Stored Cross-Site Scripting (XSS).
**Learning:** While serializers (like `SupportTicketCreateSerializer`) handled input sanitization automatically for initial ticket creation, subsequent ticket reply views performed manually constructed queries and object instantiation without routing the text inputs through sanitization filters (`sanitize_text`).
**Prevention:** Ensure any user-supplied text fields (including support replies, notes, descriptions, and comments) are explicitly passed through bleach-based sanitizers (such as `sanitize_text`) and bounded with length restrictions (e.g., 5000 characters) before database persistence. Always implement automated security tests that verify sanitization and input-length limit enforcement for all communication channels.
