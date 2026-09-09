## 2026-09-09 - Stored XSS in Challenge Chat REST API Endpoint
**Vulnerability:** The `challenge_chat` REST endpoint allowed users to submit un-sanitized chat messages containing raw HTML/script tags, which were stored in `ChallengeMessage` and rendered/broadcast to other participants.
**Learning:** While the WebSocket consumer (`consumers.py`) applied `sanitize_chat_message`, the REST API view endpoint (`views.py`) was omitting the sanitization step and relying only on length checks.
**Prevention:** Ensure both WebSocket and REST endpoints for user-generated content share and enforce the same input sanitization functions (`sanitize_chat_message` or `sanitize_text`) before persisting messages to database.
