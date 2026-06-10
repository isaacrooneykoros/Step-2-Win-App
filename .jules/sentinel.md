## 2026-06-10 - Manual Sanitization Requirement in Views
**Vulnerability:** Stored XSS via support ticket replies, admin notes, and rejection reasons.
**Learning:** The project uses `SupportTicketCreateSerializer` to sanitize initial ticket creation, but subsequent updates and replies are handled in views using `request.data.get()` directly or via serializers that don't enforce sanitization logic. This led to multiple endpoints being vulnerable to Stored XSS despite a sanitization utility being available.
**Prevention:** Always apply `sanitize_text` from `apps.core.sanitizers` in view logic when handling user or admin-supplied text that will be persisted and later displayed, especially for fields like `message`, `reason`, and `admin_notes`.
