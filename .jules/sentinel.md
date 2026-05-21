## 2026-05-21 - Missing sanitization in group chat
**Vulnerability:** Challenge chat messages were being saved to the database and broadcasted via WebSockets without any sanitization, allowing for Stored XSS.
**Learning:** Even when some parts of the app (like support tickets) use serializers that sanitize data, other endpoints using raw `request.data` might miss these protections.
**Prevention:** Always use centralized sanitization utilities for any user-supplied text field, especially in multi-user environments like group chats.
