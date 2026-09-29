/** 0:42 · 12:05 · 1:02:09 */
export function formatDuration(totalSeconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/** "850 m" below 1 km, else "2.43 km". */
export function formatDistance(meters: number | null | undefined): string {
  const m = Math.max(0, Number(meters) || 0);
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km`;
}

/** Minutes per km ("11:40 /km"), or "–" until there is enough distance to say. */
export function formatPace(seconds: number | null | undefined, meters: number | null | undefined): string {
  const s = Number(seconds) || 0;
  const m = Number(meters) || 0;
  if (m < 50 || s <= 0) return '–';
  const perKm = s / (m / 1000);
  if (!Number.isFinite(perKm) || perKm > 99 * 60) return '–';
  const min = Math.floor(perKm / 60);
  const sec = Math.round(perKm % 60);
  return `${min}:${String(sec === 60 ? 59 : sec).padStart(2, '0')} /km`;
}

export function formatWalkDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
