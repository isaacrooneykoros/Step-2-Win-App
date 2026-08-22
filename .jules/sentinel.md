## 2026-08-22 - Support Ticket Reply Stored XSS & Validation
**Vulnerability:** Support ticket replies in both user (`apps.users`) and admin (`apps.admin_api`) views stored raw message inputs without HTML sanitization or length limits, exposing administrators and users to Stored XSS and DoS.
**Learning:** `sanitize_text` in `apps.core.sanitizers` raises `django.core.exceptions.ValidationError` when length limits are exceeded. Views must catch `DjangoValidationError` to return structured 400 Bad Request responses rather than unhandled 500 errors.
**Prevention:** Always apply `sanitize_text(message, max_length=...)` to free-text endpoints before creating ORM objects, and catch `DjangoValidationError` to convert to HTTP 400.
