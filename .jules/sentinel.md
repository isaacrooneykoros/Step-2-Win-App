## 2026-10-28 - Dual Transport Sanitization (WebSocket vs REST HTTP)
**Vulnerability:** Stored XSS in challenge group chat REST API endpoint (`/api/challenges/<id>/chat/`).
**Learning:** Chat inputs were sanitized when received via WebSocket consumers (`consumers.py`), but the corresponding REST API POST endpoint (`views.py`) saved raw unsanitized user inputs into `ChallengeMessage` models.
**Prevention:** Always apply `sanitize_chat_message` across all ingestion channels (both WebSocket consumers and HTTP REST endpoints) for real-time and chat features.
