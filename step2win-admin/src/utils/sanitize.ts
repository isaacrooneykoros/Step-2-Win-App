import DOMPurify from 'dompurify';

/**
 * Sanitize HTML content before rendering with dangerouslySetInnerHTML.
 * Used for legal documents and any admin-edited rich text.
 */
export function sanitizeHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'p', 'br', 'strong', 'em', 'u',
      'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead',
      'tbody', 'tr', 'th', 'td', 'a',
    ],
    ALLOWED_ATTR: ['class', 'style', 'href', 'target', 'rel'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input'],
    // Force safe link targets
    FORCE_BODY: false,
  });
}

/**
 * Strip ALL HTML — for plain text fields.
 */
export function stripHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
}
