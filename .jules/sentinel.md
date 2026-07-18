# Sentinel Security Journal - Step2Win

## 2026-07-18 - Support Ticket Reply Stored XSS Hardening
**Vulnerability:** User and admin support ticket reply views (`reply_support_ticket`) did not sanitize the `message` input, presenting a risk of Stored XSS where malicious script or HTML payloads could be executed when viewed by users or admins.
**Learning:** Even if serializers sanitize creation inputs, manual sanitization (`sanitize_text`) is required in custom view methods handling updates or replies before persisting raw text payloads to the database.
**Prevention:** Apply `sanitize_text(value, max_length)` on all custom text field inputs in views and check that the resulting cleaned string is non-empty before creation or update.

## 2026-07-18 - Atomic Transaction Locking and Order of Operations
**Vulnerability:** Business logic involving critical balance checks and modifications must lock the corresponding records via `select_for_update()` at the very beginning of the `transaction.atomic()` block. Any reference before assignment or delay in locking can cause `UnboundLocalError` or high-concurrency race conditions.
**Learning:** Doing updates or checks on user properties before locking them under transaction atomic causes data inconsistencies and potential race-condition balance bypass.
**Prevention:** Always locate user locking at the top of the atomic transaction block, perform balance/limit validations on the locked model instance, and increment counters in a single DB save call for efficiency and atomic safety.
