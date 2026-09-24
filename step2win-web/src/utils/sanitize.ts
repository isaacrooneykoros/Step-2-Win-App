import DOMPurify from 'dompurify';

// Same allow-list as the admin console (step2win-admin/src/utils/sanitize.ts), so what an admin
// previews is exactly what users see.
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'p', 'br', 'strong', 'em', 'u',
  'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead',
  'tbody', 'tr', 'th', 'td', 'a',
];
const ALLOWED_ATTR = ['class', 'style', 'href', 'target', 'rel'];

let hooked = false;
function ensureLinkHook() {
  if (hooked) return;
  hooked = true;
  // Links that open a new tab must not get a handle on this window.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/** Sanitize server-provided rich text (legal documents) before dangerouslySetInnerHTML. */
export function sanitizeHtml(dirty: string | null | undefined): string {
  ensureLinkHook();
  return DOMPurify.sanitize(dirty ?? '', {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'style'],
  });
}
