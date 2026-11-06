# Sentinel's Journal

## 2026-11-06 - Support Ticket Reply Stored XSS Mitigation
**Vulnerability:** Support ticket message replies from both regular users (`/api/auth/support/tickets/<id>/reply/`) and admin staff (`/api/admin/support/tickets/<id>/reply/`) were persisted into `SupportTicketMessage` without input sanitization or length limits, exposing both users and admins to Stored Cross-Site Scripting (XSS) and message size abuse.
**Learning:** Initial ticket creation in `apps/users/serializers.py` used `sanitize_text(value, max_length=5000)`, but subsequent thread replies bypassed serializers and used raw `request.data.get("message")` directly in the view logic.
**Prevention:** Always route threaded messaging inputs through `sanitize_text(..., max_length=5000)` or dedicated serializers before storing messages in `SupportTicketMessage`.
