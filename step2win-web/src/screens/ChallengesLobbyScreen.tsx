import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpDown, ChevronDown, Compass, Footprints, Search, SearchX, X } from 'lucide-react';
import { challengesService } from '../services/api/challenges';
import type { LobbyChallenge, LobbyFilter, LobbySort, MilestoneFilter } from '../types';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import Input from '../components/ui/Input';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorState } from '../components/ui/ErrorState';
import { ChoiceChips } from '../components/challenge/ChoiceChips';
import { ChallengeCard, ChallengeCardSkeleton } from '../components/challenge/ChallengeCard';
import { lobbyToCardModel, milestoneTier } from '../components/challenge/challengeUtils';
import { formatSteps } from '../lib/format';
import { usePollInterval } from '../hooks/useDataSaver';

const FILTERS: { value: LobbyFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'joinable', label: 'Open to join' },
  { value: 'active', label: 'Live now' },
  { value: 'ending_soon', label: 'Ending soon' },
];

const SORTS: { value: LobbySort; label: string }[] = [
  { value: 'featured', label: 'Featured first' },
  { value: 'pool', label: 'Largest pool' },
  { value: 'filling', label: 'Filling fastest' },
  { value: 'ending', label: 'Ending soonest' },
  { value: 'newest', label: 'Newest' },
];

/** Used only until /challenges/config/ loads. */
const FALLBACK_MILESTONES = [10000, 15000, 20000, 25000, 30000, 40000, 50000, 65000, 80000, 100000, 125000, 150000, 200000, 250000, 300000];

function SelectField({
  id,
  label,
  value,
  onChange,
  icon,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-muted" aria-hidden>
        {icon}
      </span>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 w-full appearance-none truncate rounded-control border border-border bg-bg-card pl-9 pr-8 text-callout font-semibold text-text-primary outline-none transition-colors duration-fast hover:bg-bg-input focus-visible:border-brand"
      >
        {children}
      </select>
      <ChevronDown size={16} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden />
    </div>
  );
}

export default function ChallengesLobbyScreen() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<LobbyFilter>('all');
  const [milestone, setMilestone] = useState<MilestoneFilter>('all');
  const [sort, setSort] = useState<LobbySort>('featured');
  const [search, setSearch] = useState('');

  const lobbyPoll = usePollInterval(10_000);
  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ['challenges', 'lobby', filter, milestone, sort],
    queryFn: () =>
      challengesService.getLobby({
        filter,
        milestone: milestone === 'all' ? undefined : milestone,
        sort,
      }),
    refetchInterval: lobbyPoll,
    refetchOnWindowFocus: true,
  });

  const { data: config } = useQuery({
    queryKey: ['challenges', 'config'],
    queryFn: challengesService.getConfig,
    staleTime: 10 * 60_000,
  });

  const milestoneOptions = useMemo(
    () =>
      config?.challenge_milestones?.length
        ? config.challenge_milestones.map((m) => ({ value: m.value, tier: milestoneTier(m.label) }))
        : FALLBACK_MILESTONES.map((value) => ({ value, tier: null as string | null })),
    [config],
  );

  const challenges: LobbyChallenge[] = (data?.challenges || []).filter((c) => !c.user_is_joined);
  const query = search.trim().toLowerCase();
  const filtered = query ? challenges.filter((c) => c.name.toLowerCase().includes(query)) : challenges;

  const filtersActive = filter !== 'all' || milestone !== 'all';
  const resetFilters = () => {
    setFilter('all');
    setMilestone('all');
  };

  const endingSoon = data?.filters?.ending_soon ?? 0;

  return (
    <div className="pb-nav">
      <ScreenHeader back="/challenges" title="Discover" />

      <div className="space-y-4 px-5">
        <p className="text-callout text-text-secondary">
          Public challenges anyone can join. Reach the step goal before the end date to share the pool.
        </p>

        <Input
          type="search"
          aria-label="Search challenges by name"
          placeholder="Search by name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          leading={<Search size={18} />}
          trailing={
            search ? (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full text-text-muted hover:bg-bg-input"
                aria-label="Clear search"
              >
                <X size={18} />
              </button>
            ) : undefined
          }
          containerClassName="!mb-0"
        />

        <ChoiceChips
          label="Show challenges"
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => ({ ...f, count: f.value === 'ending_soon' ? endingSoon : undefined }))}
        />

        <div className="flex gap-2">
          <SelectField
            id="lobby-sort"
            label="Sort by"
            value={sort}
            onChange={(v) => setSort(v as LobbySort)}
            icon={<ArrowUpDown size={16} />}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            id="lobby-goal"
            label="Step goal"
            value={milestone}
            onChange={setMilestone}
            icon={<Footprints size={16} />}
          >
            <option value="all">Any goal</option>
            {milestoneOptions.map((m) => (
              <option key={m.value} value={String(m.value)}>
                {formatSteps(m.value)} steps{m.tier ? ` · ${m.tier}` : ''}
              </option>
            ))}
          </SelectField>
        </div>

        <section aria-labelledby="lobby-results" aria-busy={isLoading || undefined}>
          <div className="mb-3 flex min-h-[28px] items-center justify-between gap-3">
            <h2 id="lobby-results" className="eyebrow" aria-live="polite">
              {isLoading ? 'Loading challenges' : `${filtered.length} ${filtered.length === 1 ? 'challenge' : 'challenges'}`}
            </h2>
            {filtersActive && !isLoading && (
              <button type="button" onClick={resetFilters} className="-my-2 min-h-touch px-1 text-callout font-semibold text-brand">
                Reset filters
              </button>
            )}
          </div>

          {isLoading ? (
            <div className="grid gap-3 md:grid-cols-2">
              <ChallengeCardSkeleton variant="lobby" />
              <ChallengeCardSkeleton variant="lobby" />
              <ChallengeCardSkeleton variant="lobby" />
            </div>
          ) : isError && !data ? (
            <ErrorState
              title="Couldn't load challenges"
              description="Check your connection and try again."
              onRetry={() => void refetch()}
              isRetrying={isRefetching}
            />
          ) : filtered.length === 0 ? (
            <div className="rounded-card border border-dashed border-border">
              {query ? (
                <EmptyState
                  icon={SearchX}
                  title="No matches"
                  description={`No open challenge is called "${search.trim()}". Try another name.`}
                  action={{ label: 'Clear search', onClick: () => setSearch('') }}
                />
              ) : filtersActive ? (
                <EmptyState
                  icon={SearchX}
                  title="Nothing matches these filters"
                  description="Try a different goal or show all challenges."
                  action={{ label: 'Reset filters', onClick: resetFilters }}
                />
              ) : (
                <EmptyState
                  icon={Compass}
                  title="No open challenges right now"
                  description="New public challenges appear here. You can also start one and invite friends."
                  action={{ label: 'Create a challenge', onClick: () => navigate('/challenges', { state: { openCreate: true } }) }}
                />
              )}
            </div>
          ) : (
            <ul className="stagger grid gap-3 md:grid-cols-2">
              {filtered.map((c) => (
                <li key={c.id} className="min-w-0">
                  <ChallengeCard variant="lobby" challenge={lobbyToCardModel(c)} to={`/challenges/lobby/${c.id}`} className="h-full" />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
