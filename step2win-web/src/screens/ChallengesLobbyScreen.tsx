import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search,
  SlidersHorizontal,
  Flame,
  Clock,
  Trophy,
  Users,
  TrendingUp,
  ChevronRight,
  Star,
  Zap,
} from 'lucide-react';
import { challengesService } from '../services/api/challenges';
import type { LobbyChallenge, LobbyFilter, MilestoneFilter } from '../types';

const THEME: Record<string, { bg: string; accent: string; badge: string }> = {
  blue: { bg: 'hsl(var(--bg-input))', accent: '#4F9CF9', badge: 'hsl(var(--bg-elevated))' },
  green: { bg: 'hsl(var(--bg-input))', accent: '#34D399', badge: 'hsl(var(--bg-elevated))' },
  purple: { bg: 'hsl(var(--bg-input))', accent: '#A78BFA', badge: 'hsl(var(--bg-elevated))' },
  orange: { bg: 'hsl(var(--bg-input))', accent: '#FB923C', badge: 'hsl(var(--bg-elevated))' },
  pink: { bg: 'hsl(var(--bg-input))', accent: '#F472B6', badge: 'hsl(var(--bg-elevated))' },
};

const FILTERS: { key: LobbyFilter; label: string; icon: React.ReactNode }[] = [
  { key: 'all', label: 'All', icon: <Trophy size={12} /> },
  { key: 'joinable', label: 'Open', icon: <Zap size={12} /> },
  { key: 'active', label: 'Active', icon: <Flame size={12} /> },
  { key: 'ending_soon', label: 'Ending Soon', icon: <Clock size={12} /> },
];

const MILESTONES: { key: MilestoneFilter; label: string }[] = [
  { key: 'all', label: 'All Levels' },
  { key: '50000', label: '50K Beginner' },
  { key: '70000', label: '70K Mid' },
  { key: '90000', label: '90K Hard' },
];

interface ChallengesLobbyScreenProps {
  embedded?: boolean;
}

export default function ChallengesLobbyScreen({ embedded = false }: ChallengesLobbyScreenProps) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<LobbyFilter>('all');
  const [milestone, setMilestone] = useState<MilestoneFilter>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [search, setSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['challenges', 'lobby', filter, milestone],
    queryFn: () =>
      challengesService.getLobby({
        filter,
        milestone: milestone === 'all' ? undefined : milestone,
      }),
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  const challenges: LobbyChallenge[] = (data?.challenges || []).filter((c) => !c.user_is_joined);

  const filtered = search.trim()
    ? challenges.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
    : challenges;

  const featured = filtered.filter((c) => c.is_featured);
  const regular = filtered.filter((c) => !c.is_featured);

  return (
    <div className={embedded ? '' : 'min-h-screen pb-24'} style={{ background: embedded ? 'transparent' : 'hsl(var(--bg-page))' }}>
      <div className="px-4 pt-6 pb-3">
        <div className="flex items-center justify-between mb-1">
          <div>
            <h1 className="text-text-primary text-xl font-bold">Discover</h1>
            <p className="text-text-muted text-xs">{challenges.length} public challenges live</p>
          </div>
          <button
            onClick={() => setShowFilters((v) => !v)}
            className="w-9 h-9 rounded-xl flex items-center justify-center relative"
            style={{
              background: showFilters ? 'hsl(var(--bg-input))' : 'hsl(var(--bg-elevated))',
              boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
              border: '1px solid hsl(var(--border-default))',
            }}
          >
            <SlidersHorizontal size={16} color={showFilters ? '#4F9CF9' : 'hsl(var(--text-secondary))'} />
          </button>
        </div>
      </div>

      <div className="px-4 mb-3">
        <div
          className="flex items-center gap-2 px-3 py-2.5 rounded-xl"
          style={{ background: 'hsl(var(--bg-card))', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', border: '1px solid hsl(var(--border-light))' }}
        >
          <Search size={15} color="hsl(var(--text-muted))" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search challenges..."
            className="flex-1 text-sm text-text-primary bg-transparent outline-none placeholder:text-text-muted"
          />
        </div>
      </div>

      <div className="px-4 mb-3">
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap flex-shrink-0 transition-all"
              style={{
                background: filter === f.key ? '#4F9CF9' : 'hsl(var(--bg-elevated))',
                color: filter === f.key ? '#FFFFFF' : 'hsl(var(--text-secondary))',
                boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
                border: filter === f.key ? 'none' : '1px solid hsl(var(--border-default))',
              }}
            >
              {f.icon}
              {f.label}
              {f.key === 'ending_soon' && (data?.filters?.ending_soon || 0) > 0 && (
                <span
                  className="ml-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold"
                  style={{
                    background: filter === 'ending_soon' ? 'rgba(255,255,255,0.3)' : '#FEE2E2',
                    color: filter === 'ending_soon' ? '#fff' : '#EF4444',
                  }}
                >
                  {data?.filters?.ending_soon}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {showFilters && (
        <div
          className="mx-4 mb-4 p-4 rounded-2xl"
          style={{ background: 'hsl(var(--bg-card))', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}
        >
          <p className="text-text-primary text-xs font-bold mb-2">Difficulty</p>
          <div className="flex gap-2">
            {MILESTONES.map((m) => (
              <button
                key={m.key}
                onClick={() => setMilestone(m.key)}
                className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all"
                style={{
                  background: milestone === m.key ? '#EFF6FF' : '#F9FAFB',
                  color: milestone === m.key ? '#4F9CF9' : 'hsl(var(--text-secondary))',
                  border: milestone === m.key ? '1px solid #BFDBFE' : '1px solid hsl(var(--border-light))',
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {isLoading && (
        <div className="flex flex-col gap-3 px-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 rounded-2xl animate-pulse" style={{ background: '#E5E7EB' }} />
          ))}
        </div>
      )}

      {!isLoading && featured.length > 0 && (
        <div className="mb-2">
          <div className="flex items-center gap-2 px-4 mb-3">
            <Star size={14} color="#FBBF24" fill="#FBBF24" />
            <p className="text-text-primary text-sm font-bold">Featured</p>
          </div>
          <div className="px-4 flex flex-col gap-3">
            {featured.map((c) => (
              <LobbyCard key={c.id} challenge={c} onTap={() => navigate(`/challenges/lobby/${c.id}`)} />
            ))}
          </div>
        </div>
      )}

      {!isLoading && (
        <div className="px-4 flex flex-col gap-3">
          {regular.length > 0 && featured.length > 0 && (
            <p className="text-text-muted text-xs font-semibold uppercase tracking-wide mt-1">All Challenges</p>
          )}
          {regular.map((c) => (
            <LobbyCard key={c.id} challenge={c} onTap={() => navigate(`/challenges/lobby/${c.id}`)} />
          ))}
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="flex flex-col items-center py-20 px-8 text-center">
          <div className="w-16 h-16 rounded-3xl flex items-center justify-center mb-4 bg-tint-blue">
            <Trophy size={28} color="#4F9CF9" />
          </div>
          <p className="text-text-primary font-bold text-lg mb-2">No challenges found</p>
          <p className="text-text-muted text-sm leading-relaxed">
            {search ? `No results for "${search}"` : 'No public challenges match your filters right now.'}
          </p>
        </div>
      )}
    </div>
  );
}

function LobbyCard({
  challenge: c,
  onTap,
}: {
  challenge: LobbyChallenge;
  onTap: () => void;
}) {
  const theme = THEME[c.theme] || THEME.blue;

  const urgencyLabel = () => {
    if (c.is_almost_full) return { text: `${c.spots_remaining} spots left!`, color: '#EF4444' };
    if (c.is_starting_soon) return { text: 'Starting soon!', color: '#F59E0B' };
    if (c.days_remaining <= 1 && c.status === 'active') return { text: 'Last 24 hours!', color: '#EF4444' };
    if (c.days_remaining <= 2 && c.status === 'active') return { text: `${c.days_remaining}d left`, color: '#F59E0B' };
    return null;
  };

  const urgency = urgencyLabel();

  return (
    <button
      onClick={onTap}
      className="w-full text-left rounded-2xl overflow-hidden active:scale-[0.98] transition-transform"
      style={{
        background: 'hsl(var(--bg-card))',
        boxShadow: '0 1px 6px rgba(0,0,0,0.07)',
        border: c.is_featured ? `1.5px solid ${theme.accent}` : '1px solid hsl(var(--border-light))',
      }}
    >
      <div className="h-1.5 w-full" style={{ background: theme.accent }} />

      <div className="p-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-0.5">
              {c.is_featured && (
                <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: '#FEF3C7', color: '#D97706' }}>
                  <Star size={9} fill="#D97706" color="#D97706" /> Featured
                </span>
              )}
              {c.is_platform_challenge && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: theme.badge, color: theme.accent }}>
                   Official
                </span>
              )}
              {urgency && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: '#FEE2E2', color: urgency.color }}>
                   {urgency.text}
                </span>
              )}
            </div>
            <h3 className="text-text-primary text-base font-bold leading-tight truncate">{c.name}</h3>
          </div>
          <ChevronRight size={16} color="hsl(var(--text-muted))" className="flex-shrink-0 mt-1" />
        </div>

        <div className="rounded-xl px-3 py-2.5 mb-3 flex items-center gap-3" style={{ background: theme.bg }}>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: theme.accent }}>
              Prize Pool
            </p>
            <p className="text-text-primary text-lg font-bold leading-tight">KES {Number(c.effective_pool_kes).toLocaleString()}</p>
            {Number(c.platform_bonus_kes) > 0 && (
              <p className="text-[10px]" style={{ color: theme.accent }}>
                +KES {Number(c.platform_bonus_kes).toLocaleString()} platform bonus
              </p>
            )}
          </div>
          <div className="ml-auto text-right">
            <p className="text-[10px] text-text-muted">Entry fee</p>
            <p className="text-text-primary text-sm font-bold">KES {Number(c.entry_fee).toLocaleString()}</p>
          </div>
        </div>

        <div className="flex items-center gap-4 mb-3">
          <div className="flex items-center gap-1.5">
            <TrendingUp size={12} color="hsl(var(--text-muted))" />
            <span className="text-text-secondary text-xs">{c.milestone_label}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Clock size={12} color="hsl(var(--text-muted))" />
            <span className="text-text-secondary text-xs">
              {c.status === 'active'
                ? `${c.days_remaining}d remaining`
                : c.is_starting_soon
                  ? 'Starting soon'
                  : `Starts ${new Date(c.start_date || '').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
            </span>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <Users size={12} color="hsl(var(--text-muted))" />
              <span className="text-text-secondary text-xs">
                {c.participant_count} / {c.max_participants} joined
              </span>
            </div>
            <span className="text-xs font-semibold" style={{ color: c.is_almost_full ? '#EF4444' : theme.accent }}>
              {c.spots_remaining} spots left
            </span>
          </div>
          <div className="w-full h-1.5 rounded-full" style={{ background: 'hsl(var(--bg-input))' }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${c.fill_percentage}%`,
                background: c.is_almost_full ? '#EF4444' : theme.accent,
              }}
            />
          </div>
        </div>

        <div className="mt-3">
          {c.user_is_joined ? (
            <div className="w-full py-2.5 rounded-xl text-center text-sm font-bold bg-tint-green text-accent-green">
               You're In
            </div>
          ) : c.status === 'active' && c.spots_remaining === 0 ? (
            <div className="w-full py-2.5 rounded-xl text-center text-sm font-bold bg-bg-input text-text-muted border border-border-light">
              Full  Watch Leaderboard 
            </div>
          ) : (
            <div className="w-full py-2.5 rounded-xl text-center text-sm font-bold text-white" style={{ background: theme.accent, boxShadow: `0 4px 12px ${theme.accent}40` }}>
              {c.status === 'pending' ? 'Join Challenge' : 'Join Now'}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}


