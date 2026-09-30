import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Bell, ChevronRight, PartyPopper, Shield, Trophy, UserCheck, UserPlus, Users, type LucideIcon } from 'lucide-react';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { ListGroup } from '../../components/ui/ListRow';
import { IconTile } from '../../components/ui/Pill';
import { EmptyState } from '../../components/ui/EmptyState';
import { LoadError } from '../../components/ui/ErrorState';
import { Skeleton } from '../../components/ui/Skeleton';
import { socialService, type SocialNotification } from '../../services/api/social';
import { formatRelativeTime, formatSteps } from '../../lib/format';
import { ordinal, socialKeys } from '../../components/social/socialUtils';

function present(n: SocialNotification): { icon: LucideIcon; title: string; subtitle?: string; to: string } {
  const who = n.actor?.username ?? 'Someone';
  const d = n.data as Record<string, unknown>;
  switch (n.kind) {
    case 'friend_request':
      return { icon: UserPlus, title: `${who} wants to be friends`, to: '/social?tab=friends' };
    case 'friend_accepted':
      return { icon: UserCheck, title: `${who} accepted your friend request`, to: '/social' };
    case 'reaction':
      return { icon: PartyPopper, title: `${who} cheered your milestone`, to: '/social?tab=feed' };
    case 'team_role': {
      const role = String(d.role ?? '');
      return { icon: Shield, title: role === 'owner' ? `You’re now the owner of ${d.team_name}` : role === 'admin' ? `You’re now an admin of ${d.team_name}` : `Your role in ${d.team_name} changed`, to: `/social/teams/${d.team_id}` };
    }
    case 'team_removed':
      return { icon: Users, title: `You were removed from ${d.team_name}`, to: '/social?tab=teams' };
    case 'weekly_results': {
      const parts: string[] = [];
      if (typeof d.friends_rank === 'number') parts.push(`${ordinal(d.friends_rank)} of ${d.friends_size} among friends`);
      const team = d.team as { team_name?: string; rank?: number } | undefined;
      if (team?.rank) parts.push(`${team.team_name} finished ${ordinal(team.rank)}`);
      return {
        icon: Trophy,
        title: 'Last week’s results are in',
        subtitle: [`${formatSteps(Number(d.steps ?? 0))} steps`, ...parts].join(' · '),
        to: '/social',
      };
    }
    default:
      return { icon: Bell, title: 'Update', to: '/social' };
  }
}

export default function SocialInboxScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: socialKeys.notifications, queryFn: socialService.notifications, staleTime: 30_000 });
  const markRead = useMutation({
    mutationFn: () => socialService.markRead(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: socialKeys.summary }),
  });

  const hasUnread = (query.data ?? []).some((n) => !n.read);
  useEffect(() => {
    // Opening the inbox counts as reading it; unread dots stay visible until you leave.
    if (hasUnread && !markRead.isPending && !markRead.isSuccess) markRead.mutate();
  }, [hasUnread, markRead]);

  return (
    <div className="pb-nav">
      <ScreenHeader title="Updates" back="/social" />
      <div className="mx-auto w-full max-w-2xl px-5 pb-8 pt-2">
        {query.isLoading ? (
          <Skeleton className="h-56 rounded-card" />
        ) : query.isError ? (
          <LoadError resource="your updates" onRetry={() => query.refetch()} isRetrying={query.isFetching} />
        ) : (query.data ?? []).length === 0 ? (
          <EmptyState icon={Bell} title="No updates yet" description="Friend requests and your weekly results show up here." />
        ) : (
          <ListGroup>
            {(query.data ?? []).map((n) => {
              const p = present(n);
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => navigate(p.to)}
                  className="flex min-h-[60px] w-full items-start gap-3 px-4 py-3 text-left hover:bg-bg-input/60 active:!scale-100 active:bg-bg-input"
                >
                  <span className="relative mt-0.5">
                    <IconTile icon={p.icon} tone={n.read ? 'neutral' : 'brand'} size="sm" />
                    {!n.read && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg-card bg-brand" aria-label="Unread" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-body ${n.read ? 'font-medium' : 'font-semibold'} text-text-primary`}>{p.title}</span>
                    {p.subtitle && <span className="mt-0.5 block text-caption text-text-secondary">{p.subtitle}</span>}
                    <span className="mt-0.5 block text-caption text-text-muted">{formatRelativeTime(n.created_at)}</span>
                  </span>
                  <ChevronRight size={18} className="mt-1 shrink-0 text-text-muted" aria-hidden />
                </button>
              );
            })}
          </ListGroup>
        )}
      </div>
    </div>
  );
}
