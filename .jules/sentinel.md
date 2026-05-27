## 2026-05-27 - Atomic Wallet Balance Checks
**Vulnerability:** Race conditions in challenge participation logic allowed potential double-spending or bypassing of available balance checks.
**Learning:** Performing validation logic (like `available_balance` checks) outside or before obtaining a database lock (`select_for_update()`) in high-concurrency environments like a fitness challenge platform leads to state inconsistencies.
**Prevention:** Always fetch and lock the user row (and other relevant financial entities) at the very beginning of a `transaction.atomic()` block before performing any validations or calculations.

## 2026-05-27 - Inconsistent REST/WebSocket Sanitization
**Vulnerability:** Stored XSS in the REST API chat endpoint while the WebSocket counterpart was protected.
**Learning:** When providing multiple protocols for the same feature (e.g., REST and WebSockets), security controls must be applied consistently across all entry points. Input sanitization should ideally happen at the service or model level, or be explicitly enforced in every view.
**Prevention:** Use a centralized sanitization utility and verify all ingress points for user-supplied content that will be rendered for other users.
