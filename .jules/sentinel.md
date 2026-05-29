## 2026-05-29 - [Stored XSS in Support Ticket System]
**Vulnerability:** User-supplied text in support ticket replies and admin notes was stored without sanitization, allowing for Stored XSS attacks.
**Learning:** While initial ticket creation was protected via serializers, subsequent replies in views were not, highlighting the need for consistent sanitization across all input vectors.
**Prevention:** Use a centralized sanitization utility like `sanitize_text` in both serializers and views for all user-supplied text fields before database persistence.
