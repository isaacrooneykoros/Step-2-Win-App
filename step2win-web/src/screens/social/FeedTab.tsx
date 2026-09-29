import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Award, Dumbbell, Flame, Footprints, HandMetal, PartyPopper, Target, Trophy, type LucideIcon } from 'lucide-react';
import { Avatar } from '../../components/ui/Avatar';
import { EmptyState } from '../../components/ui/EmptyState';
import { LoadError } from '../../components/ui/ErrorState';
import Button from '../../components/ui/Button';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { socialService, type FeedItem, type FeedPage, type ReactionKind } from '../../services/api/social';
import { formatRelativeTime, formatSteps } from '../../lib/format';
import { socialKeys } from '../../components/social/socialUtils';

const REACTIONS: Array<{ kind: ReactionKind; icon: LucideIcon; label: string }> = [
  { kind: 'cheer', icon: PartyPopper, label: 'Cheer' },
  { kind: 'fire', icon: Flame, label: 'On fire' },
  { kind: 'strong', icon: Dumbbell, label: 'Strong' },
  { kind: 'clap', icon: HandMetal, label: 'Well done' },
];

function describe(item: FeedItem): { icon: LucideIcon; text: string } {
  const who = item.is_me ? 'You' : item.user.username;
  switch (item.kind) {
    case 'goal_hit':
      return { icon: Target, text: `${who} reached ${item.is_me ? 'your' : 'their'} daily goal${item.data.goal ? ` of ${formatSteps(Number(item.data.goal))} steps` : ''}` };
    case 'streak':
      return { icon: Flame, text: `${who} ${item.is_me ? 'are' : 'is'} on a ${item.data.days}-day streak` };
    case 'badge':
      return { icon: Award, text: `${who} earned the ${item.data.badge_name ?? 'new'} badge` };
    case 'challenge_qualified':
      return { icon: Footprints, text: `${who} reached a ${item.data.milestone ? `${formatSteps(Number(item.data.milestone))}-step ` : ''}challenge milestone` };
    case 'weekly_winner':
      return { icon: Trophy, text: `${who} topped the friends ranking last week` };
    default:
      return { icon: Award, text: `${who} hit a milestone` };
  }
}

function FeedCard({ item, onReact, busy }: { item: FeedItem; onReact: (kind: ReactionKind | null) => void; busy: boolean }) {
  const { icon: Icon, text } = describe(item);
  const total = Object.values(item.reactions).reduce((a, b) => a + (b ?? 0), 0);
  return (
    <article className="rounded-card border border-border-light bg-bg-card p-4 shadow-card">
      <div className="flex items-start gap-3">
        <Avatar name={item.user.username} src={item.user.profile_picture_url} size="md" highlight={item.is_me} />
        <div className="min-w-0 flex-1">
          <p className="text-body text-text-primary">{text}</p>
          <p className="mt-0.5 flex items-center gap-1 text-caption text-text-muted">
            <Icon size={13} aria-hidden />
            {formatRelativeTime(item.created_at)}
            {total > 0 && <span aria-label={`${total} reactions`}> · {total} {total === 1 ? 'reaction' : 'reactions'}</span>}
          </p>
        </div>
      </div>
      {!item.is_me && (
        <div className="mt-3 flex gap-2" role="group" aria-label="React">
          {REACTIONS.map(({ kind, icon: RIcon, label }) => {
            const active = item.my_reaction === kind;
            const count = item.reactions[kind] ?? 0;
            return (
              <button
                key={kind}
                type="button"
                disabled={busy}
                aria-pressed={active}
                aria-label={`${label}${count ? ` (${count})` : ''}`}
                title={label}
                onClick={() => onReact(active ? null : kind)}
                className={[
                  'inline-flex h-9 min-w-[44px] items-center justify-center gap-1 rounded-full border px-3 text-caption font-semibold',
                  active ? 'border-brand bg-brand-soft text-brand' : 'border-border-light text-text-secondary hover:bg-bg-input',
                ].join(' ')}
              >
                <RIcon size={15} aria-hidden />
                {count > 0 && <span className="num">{count}</span>}
              </button>
            );
          })}
        </div>
      )}
      {item.is_me && total > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {REACTIONS.filter((r) => (item.reactions[r.kind] ?? 0) > 0).map(({ kind, icon: RIcon, label }) => (
            <span key={kind} className="inline-flex h-7 items-center gap-1 rounded-full bg-bg-input px-2.5 text-caption text-text-secondary" aria-label={`${label}: ${item.reactions[kind]}`}>
              <RIcon size={13} aria-hidden />
              <span className="num">{item.reactions[kind]}</span>
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

export function FeedTab() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: socialKeys.feed,
    queryFn: ({ pageParam }) => socialService.feed(pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (last: FeedPage) => last.next_before_id,
    staleTime: 60_000,
  });

  const react = useMutation({
    mutationFn: ({ id, kind }: { id: number; kind: ReactionKind | null }) => socialService.react(id, kind),
    onMutate: async ({ id, kind }) => {
      await queryClient.cancelQueries({ queryKey: socialKeys.feed });
      const previous = queryClient.getQueryData<InfiniteData<FeedPage>>(socialKeys.feed);
      queryClient.setQueryData<InfiniteData<FeedPage>>(socialKeys.feed, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((p) => ({
                ...p,
                items: p.items.map((it) => {
                  if (it.id !== id) return it;
                  const reactions = { ...it.reactions };
                  if (it.my_reaction) reactions[it.my_reaction] = Math.max(0, (reactions[it.my_reaction] ?? 1) - 1);
                  if (kind) reactions[kind] = (reactions[kind] ?? 0) + 1;
                  return { ...it, my_reaction: kind, reactions };
                }),
              })),
            }
          : data,
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(socialKeys.feed, ctx.previous);
      showToast({ message: 'Couldn’t send that reaction. Try again.', type: 'error' });
    },
  });

  if (query.isLoading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading activity">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-3 rounded-card border border-border-light bg-bg-card p-4">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-3/4 rounded" />
              <Skeleton className="h-3 w-20 rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (query.isError) {
    return <LoadError resource="activity" onRetry={() => query.refetch()} isRetrying={query.isFetching} />;
  }
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  if (items.length === 0) {
    return (
      <EmptyState
        icon={PartyPopper}
        title="Nothing here yet"
        description="When friends hit their goal, keep a streak or earn a badge, it shows up here so you can cheer them on."
        action={{ label: 'Add friends', onClick: () => navigate('/social/add') }}
      />
    );
  }
  return (
    <div className="space-y-3">
      {items.map((item) => (
        <FeedCard key={item.id} item={item} busy={react.isPending} onReact={(kind) => react.mutate({ id: item.id, kind })} />
      ))}
      {query.hasNextPage && (
        <Button variant="ghost" fullWidth isLoading={query.isFetchingNextPage} loadingText="Loading…" onClick={() => void query.fetchNextPage()}>
          Show older
        </Button>
      )}
      <p className="px-1 text-center text-caption text-text-muted">Only milestones are shared. Never your location or routes.</p>
    </div>
  );
}

export default FeedTab;
