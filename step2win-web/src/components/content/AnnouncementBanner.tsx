import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronRight, Info, X } from 'lucide-react';
import { contentService, type Announcement, type AnnouncementSeverity } from '../../services/api/content';
import { useAuthStore } from '../../store/authStore';
import { usePrefersReducedMotion } from '../../lib/motion';
import { SafeText } from './SafeText';

const STYLE: Record<AnnouncementSeverity, { card: string; icon: typeof Info; iconClass: string; link: string }> = {
  info: { card: 'bg-info-soft', icon: Info, iconClass: 'text-info', link: 'text-info' },
  warning: { card: 'bg-warning-soft', icon: AlertTriangle, iconClass: 'text-warning', link: 'text-warning' },
  success: { card: 'bg-success-soft', icon: CheckCircle2, iconClass: 'text-success', link: 'text-success' },
};

const storageKey = (userId: number | string | undefined) => `s2w_dismissed_announcements:${userId ?? 'anon'}`;

function readDismissed(userId: number | string | undefined): number[] {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(ids) ? ids.filter((x): x is number => typeof x === 'number').slice(-100) : [];
  } catch {
    return [];
  }
}

/**
 * Staff announcements on Home (Admin > Content > Announcements). Up to three,
 * highest priority first. Dismissing is remembered per account and announcement:
 * on the server (so it stays hidden on other devices) and locally (so it hides
 * at once, even offline). Renders nothing when there is nothing to show.
 */
export function AnnouncementBanner() {
  const userId = useAuthStore((s) => s.user?.id);
  const reduced = usePrefersReducedMotion();
  const [dismissed, setDismissed] = useState<number[]>(() => readDismissed(userId));
  const [leaving, setLeaving] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ['content', 'announcements', userId],
    queryFn: contentService.announcements,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  useEffect(() => setDismissed(readDismissed(userId)), [userId]);

  const items = useMemo(() => (q.data ?? []).filter((a) => !a.dismissible || !dismissed.includes(a.id)), [q.data, dismissed]);

  const dismiss = (a: Announcement) => {
    const hide = () => {
      setDismissed((prev) => {
        const next = [...prev.filter((x) => x !== a.id), a.id].slice(-100);
        try {
          localStorage.setItem(storageKey(userId), JSON.stringify(next));
        } catch {
          /* storage full or blocked: the server still remembers */
        }
        return next;
      });
      setLeaving(null);
    };
    void contentService.dismiss(a.id).catch(() => undefined);
    if (reduced) hide();
    else {
      setLeaving(a.id);
      window.setTimeout(hide, 180);
    }
  };

  if (!items.length) return null;

  return (
    <section aria-label="Announcements" className="space-y-3">
      {items.map((a) => {
        const s = STYLE[a.severity] ?? STYLE.info;
        const Icon = s.icon;
        const internal = a.link_url?.startsWith('/');
        const linkLabel = a.link_label || 'Learn more';
        return (
          <article
            key={a.id}
            role={a.severity === 'warning' ? 'alert' : 'status'}
            className={[
              'flex gap-3 rounded-card p-4',
              s.card,
              reduced ? '' : 'transition-opacity duration-fast ease-standard',
              leaving === a.id ? 'opacity-0' : 'opacity-100',
            ].join(' ')}
          >
            <Icon size={20} strokeWidth={2} className={`mt-0.5 shrink-0 ${s.iconClass}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <h3 className="text-callout font-semibold text-text-primary">{a.title}</h3>
              {a.body && <SafeText text={a.body} className="mt-0.5 text-callout text-text-secondary" />}
              {a.link_url &&
                (internal ? (
                  <Link to={a.link_url} className={`mt-2 inline-flex min-h-touch items-center gap-0.5 text-callout font-semibold ${s.link}`}>
                    {linkLabel} <ChevronRight size={16} aria-hidden />
                  </Link>
                ) : (
                  <a href={a.link_url} target="_blank" rel="noopener noreferrer" className={`mt-2 inline-flex min-h-touch items-center gap-0.5 text-callout font-semibold ${s.link}`}>
                    {linkLabel} <ChevronRight size={16} aria-hidden />
                  </a>
                ))}
            </div>
            {a.dismissible && (
              <button
                type="button"
                onClick={() => dismiss(a)}
                aria-label={`Dismiss: ${a.title}`}
                className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <X size={18} aria-hidden />
              </button>
            )}
          </article>
        );
      })}
    </section>
  );
}

export default AnnouncementBanner;
