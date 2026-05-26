## 2026-05-26 - [Stored XSS in Support Tickets and Chat]
**Vulnerability:** User-supplied text fields (support ticket messages and challenge chat) were being saved and displayed without sanitization, allowing for Stored Cross-Site Scripting (XSS).
**Learning:** Even with a `sanitizers.py` module available, developers might forget to apply it in every view that handles text input.
**Prevention:** Always sanitize user-supplied text before database persistence, especially if it's intended to be displayed to other users or admins.

## 2026-05-26 - [CRLF vs LF Diffs]
**Vulnerability:** N/A (Tooling issue)
**Learning:** Mixing line endings (CRLF in repo vs LF in tools) can cause `replace_with_git_merge_diff` to fail or generate unexpectedly large diffs that change every line.
**Prevention:** Convert files to LF before applying patches if the tool fails, but be aware this increases diff size.
