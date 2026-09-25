## 2026-09-25 - [Stored XSS in Legal Documents & Bandit B104 False Positive]
**Vulnerability:** Unsanitized HTML inputs in legal document creation and editing endpoints permitted potential Stored XSS vectors (e.g. script injection, image onerror event handlers, javascript URIs).
**Learning:** Bleach with `strip=True` and a strict tag/attribute whitelist is needed to preserve safe formatting tags while removing dangerous tags and attributes. Additionally, test fixtures with hardcoded interface binds (e.g. `0.0.0.0` for Daphne mock commands) trigger Bandit's B104 rule and must be annotated with `# nosec B104`.
**Prevention:** Use `sanitize_html` for HTML fields and add `# nosec B104` to mock bind strings in test suites.
