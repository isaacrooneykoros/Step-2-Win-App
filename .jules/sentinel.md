## 2026-07-26 - Balances and HTML Sanitization in Monolithic Views
**Vulnerability:** User-provided HTML content inside admin legal document creation/edit actions can result in Stored XSS if dangerous tags (`<script>`) or handlers (`onerror`) are not sanitized.
**Learning:** Direct plain-text stripping (`bleach.clean(..., tags=[])`) destroys legitimate document layout formatting. We must balance layout requirements with security by using a curated allowed-tag whitelist (`p`, `b`, `i`, `strong`, `em`, `u`, `h1`-`h6`, lists, tables, links, `span`, `div`) and attribute whitelist.
**Prevention:** Always use a tailored, configurable HTML-sanitizing wrapper (`sanitize_html`) rather than full tag-stripping when rich text/HTML persistence is required.
