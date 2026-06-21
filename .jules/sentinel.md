## 2025-06-21 - [Stored XSS in Challenge Chat REST Endpoint]
**Vulnerability:** The `challenge_chat` REST API (POST) accepted and stored raw user-supplied chat messages without sanitization, leading to a Stored XSS vulnerability. While the WebSocket consumer was protected, the REST fallback was not.
**Learning:** Security controls must be applied consistently across all entry points (REST, WebSockets, etc.) that handle the same data. Relying on frontend sanitization or partial backend coverage is insufficient.
**Prevention:** Always apply centralized sanitization utilities (like `bleach` or project-specific sanitizers) at the view/serializer layer before persisting user-generated content to the database.
