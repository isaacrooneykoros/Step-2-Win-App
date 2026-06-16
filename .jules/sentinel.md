# Sentinel's Journal

## 2026-06-16 - [Stored XSS in Chat and Support]
**Vulnerability:** Several endpoints (challenge_chat, support_ticket replies, admin_notes) accept user/admin input and save it to the database without sanitization, leading to Stored XSS.
**Learning:** While some serializers (like SupportTicketCreateSerializer) handle sanitization, manual view logic often omits it, especially in replies or actions that don't use the full serializer for input.
**Prevention:** Always use sanitization functions (sanitize_text, sanitize_chat_message) for any text field before persistence, regardless of whether it's from a user or an admin.
