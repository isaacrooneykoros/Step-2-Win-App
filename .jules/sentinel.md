# Sentinel Security Journal

## 2026-03-24 - [Stored XSS in Challenge Chat]
**Vulnerability:** The challenge chat view lacked sanitization of user-supplied message content before saving to the database and broadcasting via WebSockets.
**Learning:** Stored XSS could be injected via chat messages in private challenges, bypassing typical backend security protections since the input was trusted.
**Prevention:** Always apply the specialized `sanitize_chat_message` utility to all user-submitted chat content and handle Django ValidationError appropriately.
