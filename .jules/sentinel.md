# Sentinel Security Journal - Step2Win

## 2026-07-06 - Stored XSS in Chat and Support Tickets
**Vulnerability:** Several views accepted user-supplied text (chat messages, support replies, admin notes) and saved them directly to the database without sanitization. This allowed for Stored XSS attacks targeting both users and administrators.
**Learning:** Even when serializers handle some sanitization, manual view logic for replies or updates often bypasses these checks if not explicitly handled.
**Prevention:** Always apply `sanitize_text` or `sanitize_chat_message` in POST/PATCH handlers that deal with raw user input. Catch `django.core.exceptions.ValidationError` as `DjangoValidationError` to return clean 400 responses.

## 2026-07-06 - Race Condition in Challenge Joining
**Vulnerability:** The `join_challenge` view performed balance and limit checks before acquiring a database lock on the User object, creating a window for race conditions.
**Learning:** `select_for_update()` must be called at the very beginning of the `transaction.atomic()` block, before any business logic that depends on the object's state (like balance checks).
**Prevention:** Standardize on fetching the locked user object immediately after entering the atomic transaction.

## 2026-07-06 - Migration Blocker: Model Name Typo
**Vulnerability:** A typo in a migration constraint (`stepssyncevent` instead of `stepsyncevent`) blocked all database migrations and test execution in the local environment.
**Learning:** Typos in migration files, especially in constraint names referencing models, can be catastrophic for developer productivity and CI/CD pipelines.
**Prevention:** Verify migrations locally by running `migrate` or `test` before committing. If a typo is found in a shared migration, it must be fixed immediately.
