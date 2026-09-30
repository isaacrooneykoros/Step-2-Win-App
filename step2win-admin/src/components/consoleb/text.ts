/** One-line preview of announcement / help text without the markdown markers. */
export const plainText = (s: string) =>
  s.replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^\s*-\s+/gm, '').replace(/\s+/g, ' ').trim()
