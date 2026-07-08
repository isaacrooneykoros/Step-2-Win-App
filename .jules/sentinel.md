## 2026-07-08 - [REST vs WebSocket Sanitization Gap]
**Vulnerability:** Stored XSS in `challenge_chat` view.
**Learning:** While WebSocket consumers often have built-in or explicitly added sanitization, corresponding REST API endpoints for the same resource (like chat) can be overlooked, leading to an bypass.
**Prevention:** Always verify that both WebSocket and REST handlers for user-supplied content apply the same sanitization logic (e.g., `sanitize_chat_message`).

## 2026-07-08 - [Race Condition Protection Placement]
**Vulnerability:** Potential balance double-spend and `UnboundLocalError` in `join_challenge`.
**Learning:** Atomic transactions must start with `select_for_update()` before any business logic checks (like balance or participant limits). In this codebase, referencing the user before the lock caused both a race condition risk and a Python `UnboundLocalError` because the `user` variable was used in a check before being assigned the result of the lock.
**Prevention:** Always fetch and lock the primary actor (User) at the start of `transaction.atomic()` blocks.

## 2026-07-08 - [Migration Integrity and Typos]
**Vulnerability:** Blocked security testing due to migration error.
**Learning:** Typos in migration files (e.g., `stepssyncevent` instead of `stepsyncevent` in indices/constraints) can block the entire test suite even if the application appears to run.
**Prevention:** Run `python manage.py makemigrations --check` and verify migrations against a clean database in CI.
