## 2026-06-09 - [Atomic Transaction Order and Concurrency]
**Vulnerability:** Race condition and logic error in challenge joining. User balance and locked balance limits were checked before the user record was locked via `select_for_update()`, allowing for potential over-commitment of funds in concurrent requests.
**Learning:** In Django transactions involving financial or state-limited operations, `select_for_update()` must be invoked at the very start of the `transaction.atomic()` block. Fetching the object later or checking properties before locking creates a window for race conditions.
**Prevention:** Standardize a pattern where actor objects (Users, Wallets) are fetched with locks as the first action inside an atomic block.

## 2026-06-09 - [Typo in Migration Constraints]
**Vulnerability:** Migration failure due to `KeyError` on a model name typo in a `AddConstraint` operation.
**Learning:** Django migration operations like `AddConstraint` or `AddIndex` that reference model names as strings are not automatically validated during `makemigrations` if the typo is subtle (`stepssyncevent` vs `stepsyncevent`).
**Prevention:** Always run a full `migrate` and small smoke test in CI/CD to catch schema-level typos that don't trigger linter errors.
