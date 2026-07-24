# Sentinel's Journal - Critical Learnings

## 2026-07-24 - Stored XSS in Challenge Chat Messages
**Vulnerability:** User-submitted chat messages in private challenge chats were directly stored into the database without text sanitization or HTML tag stripping, posing a high-severity Stored XSS risk for any participant viewing the chat.
**Learning:** Legacy message fields lacked validation-based sanitization in view handlers, bypassing the standard security filters applied to support tickets or username fields.
**Prevention:** Apply `sanitize_chat_message` to all chat endpoints before database insertion, and map standard `ValidationError` types to clean REST Framework 400 responses.

## 2026-07-24 - Django Test Runner App Discovery Conflict
**Vulnerability:** Django test runner conflicts on app directories containing both a `tests.py` file and a `tests/` directory under the same app, resulting in `ImportError` and blocking test suite discovery.
**Learning:** Django cannot unambiguously resolve modules when there is both a single-file module and a directory module of the same name within the same namespace.
**Prevention:** Structure app testing folders exclusively as package directories containing `__init__.py` and separate `test_*.py` files, migrating any legacy `tests.py` scripts to avoid discovery collisions.
