## 2026-05-21 - Missing sanitization in group chat
**Vulnerability:** Challenge chat messages were being saved to the database and broadcasted via WebSockets without any sanitization, allowing for Stored XSS.
**Learning:** Even when some parts of the app (like support tickets) use serializers that sanitize data, other endpoints using raw `request.data` might miss these protections.
**Prevention:** Always use centralized sanitization utilities for any user-supplied text field, especially in multi-user environments like group chats.

## 2026-05-21 - CI failures due to environment and migration errors
**Vulnerability:** CI was failing due to missing environment variables (`APP_SIGNING_SECRET`) and a typo in migrations (`stepssyncevent`), which could mask security regressions by preventing tests from running.
**Learning:** Security tools and tests are only as good as the CI pipeline that runs them. Environment strictness can sometimes block necessary validation.
**Prevention:** Ensure CI environments are properly seeded with dummy secrets for validation and that migrations are strictly verified against model definitions.
