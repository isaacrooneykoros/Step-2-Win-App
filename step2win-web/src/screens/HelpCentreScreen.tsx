import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronDown, LifeBuoy, MessageSquarePlus, Search, X } from 'lucide-react';
import { contentService } from '../services/api/content';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { ListGroup } from '../components/ui/ListRow';
import { IconTile } from '../components/ui/Pill';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadError } from '../components/ui/ErrorState';
import { SafeText } from '../components/content/SafeText';

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Profile > Help centre: staff-written answers (Admin > Content > Help centre), with search. */
export default function HelpCentreScreen() {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const help = useQuery({
    queryKey: ['content', 'help', q],
    queryFn: () => contentService.help(q),
    placeholderData: keepPreviousData,
    staleTime: 10 * 60_000,
  });
  const [open, setOpen] = useState<number | null>(null);
  const cats = help.data?.categories ?? [];

  return (
    <div className="pb-nav">
      <ScreenHeader title="Help centre" back="/profile" />
      <div className="space-y-6 px-5 pt-2">
        <div className="relative">
          <label htmlFor="help-search" className="sr-only">Search help</label>
          <Search size={18} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            id="help-search"
            type="search"
            inputMode="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search, e.g. withdraw, steps, M-Pesa"
            className="input-field pl-11 pr-11"
            maxLength={100}
          />
          {search && (
            <button type="button" aria-label="Clear search" onClick={() => setSearch('')}
              className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-text-muted">
              <X size={18} aria-hidden />
            </button>
          )}
        </div>

        {help.isLoading ? (
          <div className="space-y-3" aria-busy>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-14 w-full rounded-card" />
            <Skeleton className="h-14 w-full rounded-card" />
            <Skeleton className="h-14 w-full rounded-card" />
          </div>
        ) : help.isError ? (
          <LoadError resource="help articles" onRetry={() => help.refetch()} isRetrying={help.isFetching} />
        ) : cats.length === 0 ? (
          <EmptyState
            icon={LifeBuoy}
            title={q ? 'No answers match your search' : 'Help articles are on their way'}
            description={q ? 'Try other words, or ask our support team.' : 'Meanwhile our support team is happy to help.'}
          />
        ) : (
          cats.map((c) => (
            <section key={c.id} aria-labelledby={`help-cat-${c.id}`}>
              <h2 id={`help-cat-${c.id}`} className="eyebrow mb-2 px-1">{c.title}</h2>
              {c.description && <p className="-mt-1 mb-2 px-1 text-caption text-text-muted">{c.description}</p>}
              <ul className="divide-y divide-border-light overflow-hidden rounded-card bg-bg-card">
                {c.articles.map((a) => {
                  const expanded = open === a.id || (q !== '' && help.data!.total <= 3);
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={`help-a-${a.id}`}
                        onClick={() => setOpen(open === a.id ? null : a.id)}
                        className="flex min-h-touch w-full items-center gap-3 px-4 py-3.5 text-left"
                      >
                        <span className="min-w-0 flex-1 text-callout font-medium text-text-primary">{a.title}</span>
                        <ChevronDown size={18} aria-hidden className={`shrink-0 text-text-muted transition-transform duration-fast ${expanded ? 'rotate-180' : ''}`} />
                      </button>
                      {expanded && (
                        <div id={`help-a-${a.id}`} className="px-4 pb-4">
                          <SafeText text={a.body} className="text-callout leading-relaxed text-text-secondary" />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}

        <ListGroup title="Still need help?">
          <Link to="/support" className="flex min-h-touch items-center gap-3 px-4 py-3.5">
            <IconTile icon={MessageSquarePlus} tone="brand" size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block text-callout font-medium text-text-primary">Contact support</span>
              <span className="block text-caption text-text-muted">We usually reply within a day</span>
            </span>
          </Link>
        </ListGroup>
      </div>
    </div>
  );
}
