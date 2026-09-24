/** Extracts a human-readable message from an axios-style error, with a plain-language fallback. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error) return record.error;
    if (typeof record.detail === 'string' && record.detail) return record.detail;
    if (typeof record.message === 'string' && record.message && !record.message.startsWith('{')) return record.message;
    // DRF field errors: { field: ["message"] }
    for (const value of Object.values(record)) {
      if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    }
  }
  return fallback;
}
