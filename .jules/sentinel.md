## 2026-07-17 - Stored XSS Hardening for Legal Document Administration
**Vulnerability:** Legal policy drafts and manual HTML edits were persistent to the database without input sanitization, exposing the administration interface to potential Stored XSS attacks from compromised or malicious admins.
**Learning:** Document converting utilities (mammoth) translate files to basic HTML formats but do not sanitize scripts or iframes. Manual request payloads also bypass serializers to save raw input.
**Prevention:** Always apply custom HTML sanitizers targeting specific tag/attribute safe-lists (using bleach) at the view level before persisting manual or generated rich text blocks.
