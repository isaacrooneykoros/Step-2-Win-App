# Sentinel's Journal

## 2026-08-03 - Atomic Lock and Variable Scope Sequencing in Django Views
**Vulnerability:** In the `join_challenge` view, critical balance and locked balance validation checks referenced the `user` object prior to it being fetched and locked via `select_for_update()`. This sequence caused `UnboundLocalError` in execution and created race conditions because balance limits were checked without database-level pessimistic locking.
**Learning:** High-concurrency operations on shared resources (such as financial wallet balances) require immediate database locking at the very start of the atomic transaction before any conditional or validation logic.
**Prevention:** Always retrieve and lock the target resource (`select_for_update()`) as the first statement in a `transaction.atomic()` block, and ensure that all references to the resource use the locked object.

## 2026-08-03 - Integrity Constraints and Swapped User Model Handling in Security Test Discovery
**Vulnerability:** Direct Django test discovery conflicts occurred due to a duplicate `tests.py` file alongside a `tests/` package. Furthermore, direct imports of `User` from `django.contrib.auth.models` bypassed Custom User Model swapping, leading to AttributeErrors.
**Learning:** Sub-app test structures must not mix single-module `tests.py` and package-level `tests/` folders. Swappable user models must always be referenced using `get_user_model()` to maintain test environment stability.
**Prevention:** Enforce consistent test suite structures and utilize `get_user_model()` exclusively for custom user model instantiation and operations.
