## 2026-07-01 - Race conditions in challenge participation and creation
**Vulnerability:** Critical business logic (balance checks and participation limits) was performed outside of atomic transactions or before row-level locks were acquired. This allowed potential race conditions where a user could join a full challenge or double-spend their balance by sending concurrent requests.
**Learning:** In Django, `transaction.atomic()` alone does not prevent race conditions on data read before modification. `select_for_update()` must be used at the very beginning of the transaction to lock the relevant rows (e.g., the User object) to ensure atomicity of the check-and-decrement pattern.
**Prevention:** Always use `select_for_update()` immediately after entering an atomic transaction when performing balance deductions or enforcing capacity limits.

## 2026-07-01 - Django test discovery conflict
**Vulnerability:** Migration and test suite were blocked due to a 'tests.py' file and a 'tests/' directory existing simultaneously in the 'steps' app, causing an `ImportError`.
**Learning:** Django's test runner can get confused when both a 'tests.py' module and a 'tests' package exist in the same app.
**Prevention:** Consolidate tests into a 'tests/' directory and remove the top-level 'tests.py' file, or vice versa.
