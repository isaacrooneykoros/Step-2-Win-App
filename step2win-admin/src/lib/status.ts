/**
 * One mapping from backend status strings to semantic tones, so the same state
 * looks the same on every page.
 */
export type BadgeTone = 'success' | 'warning' | 'danger' | 'info' | 'brand' | 'violet' | 'neutral'

const MAP: Record<string, BadgeTone> = {
  // positive / done
  active: 'success', success: 'success', completed: 'success', resolved: 'success', approved: 'success',
  paid: 'success', good: 'success', ok: 'success', healthy: 'success', published: 'success', verified: 'success',
  // waiting on someone
  pending: 'warning', pending_review: 'warning', reviewing: 'warning', review: 'warning', warning: 'warning',
  warn: 'warning', in_progress: 'info', processing: 'info', open: 'warning', medium: 'warning', draft: 'neutral',
  restrict: 'warning', restricted: 'warning', high: 'danger', urgent: 'danger',
  // negative
  failed: 'danger', rejected: 'danger', banned: 'danger', ban: 'danger', flagged: 'danger', critical: 'danger',
  suspended: 'danger', suspend: 'danger', error: 'danger', breach: 'danger',
  // neutral
  inactive: 'neutral', cancelled: 'neutral', closed: 'neutral', user: 'neutral', low: 'neutral', dismissed: 'neutral',
  archived: 'neutral', unknown: 'neutral',
  // informational
  info: 'info', public: 'info', live: 'brand',
  admin: 'violet', staff: 'violet', superuser: 'violet', private: 'violet',
}

export function statusTone(status: string | null | undefined): BadgeTone {
  if (!status) return 'neutral'
  return MAP[status.toLowerCase()] ?? 'neutral'
}
