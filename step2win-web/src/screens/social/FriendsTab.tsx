import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Check, Flag, UserMinus, UserPlus, UserX, Users, X } from 'lucide-react';
import { Avatar } from '../../components/ui/Avatar';
import Button from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { LoadError } from '../../components/ui/ErrorState';
import { ListGroup, ListRow } from '../../components/ui/ListRow';
import { IconTile } from '../../components/ui/Pill';
import { Sheet } from '../../components/ui/Sheet';
import { Skeleton } from '../../components/ui/Skeleton';
import { useToast } from '../../components/ui/Toast';
import { apiErrorMessage } from '../../components/settings/apiError';
import { ReportSheet } from '../../components/social/ReportSheet';
import { socialService, type Friend, type PublicUser } from '../../services/api/social';
import { formatRelativeTime, formatSteps } from '../../lib/format';
import { socialKeys } from '../../components/social/socialUtils';

type Confirm = { kind: 'remove' | 'block'; user: PublicUser } | null;

export function FriendsTab() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [selected, setSelected] = useState<Friend | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [reportTarget, setReportTarget] = useState<PublicUser | null>(null);

  const friendsQuery = useQuery({ queryKey: socialKeys.friends, queryFn: socialService.friends, staleTime: 60_000 });
  const requestsQuery = useQuery({ queryKey: socialKeys.requests, queryFn: socialService.requests, staleTime: 30_000 });

  const refresh = () => queryClient.invalidateQueries({ queryKey: socialKeys.all });

  const respond = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'accept' | 'decline' | 'cancel' }) => socialService.respond(id, action),
    onSuccess: (_d, { action }) => {
      refresh();
      showToast({ message: action === 'accept' ? 'You’re now friends.' : action === 'decline' ? 'Request declined.' : 'Request cancelled.', type: 'success' });
    },
    onError: (error) => {
      refresh();
      showToast({ message: apiErrorMessage(error, 'That didn’t work. Please try again.'), type: 'error' });
    },
  });

  const act = useMutation({
    mutationFn: async ({ kind, user }: { kind: 'remove' | 'block'; user: PublicUser }) =>
      kind === 'remove' ? socialService.removeFriend(user.id) : socialService.block(user.id),
    onSuccess: (_d, { kind, user }) => {
      setConfirm(null);
      setSelected(null);
      refresh();
      showToast({ message: kind === 'remove' ? `${user.username} removed from friends.` : `${user.username} is blocked.`, type: 'success' });
    },
    onError: (error) => showToast({ message: apiErrorMessage(error, 'That didn’t work. Please try again.'), type: 'error' }),
  });

  const incoming = requestsQuery.data?.incoming ?? [];
  const outgoing = requestsQuery.data?.outgoing ?? [];
  const friends = friendsQuery.data ?? [];

  return (
    <div className="space-y-6">
      <Button fullWidth leftIcon={<UserPlus size={18} aria-hidden />} onClick={() => navigate('/social/add')}>
        Add friends
      </Button>

      {incoming.length > 0 && (
        <ListGroup title={`Requests (${incoming.length})`}>
          {incoming.map((r) => (
            <div key={r.id} className="flex min-h-[64px] items-center gap-3 px-4 py-3">
              <Avatar name={r.user.username} src={r.user.profile_picture_url} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-body font-medium text-text-primary">{r.user.username}</p>
                <p className="text-caption text-text-muted">{formatRelativeTime(r.created_at)}</p>
              </div>
              <button
                type="button"
                onClick={() => respond.mutate({ id: r.id, action: 'decline' })}
                disabled={respond.isPending}
                aria-label={`Decline ${r.user.username}`}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-border text-text-secondary hover:bg-bg-input"
              >
                <X size={18} aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => respond.mutate({ id: r.id, action: 'accept' })}
                disabled={respond.isPending}
                aria-label={`Accept ${r.user.username}`}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-brand text-brand-fg hover:bg-brand-hover"
              >
                <Check size={18} aria-hidden />
              </button>
            </div>
          ))}
        </ListGroup>
      )}

      {friendsQuery.isLoading ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading friends">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 rounded-card border border-border-light bg-bg-card p-4">
              <Skeleton className="h-10 w-10 rounded-full" />
              <Skeleton className="h-4 w-32 rounded" />
            </div>
          ))}
        </div>
      ) : friendsQuery.isError ? (
        <LoadError resource="your friends" onRetry={() => friendsQuery.refetch()} isRetrying={friendsQuery.isFetching} />
      ) : friends.length === 0 ? (
        <EmptyState icon={Users} title="No friends yet" description="Search by username, scan a friend’s QR or share your own invite link." />
      ) : (
        <ListGroup title={`Friends (${friends.length})`}>
          {friends.map((f) => (
            <ListRow
              key={f.id}
              leading={<Avatar name={f.username} src={f.profile_picture_url} />}
              title={f.username}
              subtitle={`${formatSteps(f.week_steps)} steps this week`}
              onClick={() => setSelected(f)}
              chevron
            />
          ))}
        </ListGroup>
      )}

      {outgoing.length > 0 && (
        <ListGroup title="Sent requests">
          {outgoing.map((r) => (
            <ListRow
              key={r.id}
              leading={<Avatar name={r.user.username} src={r.user.profile_picture_url} size="sm" />}
              title={r.user.username}
              subtitle={`Sent ${formatRelativeTime(r.created_at)}`}
              trailing={
                <Button size="sm" variant="ghost" disabled={respond.isPending} onClick={() => respond.mutate({ id: r.id, action: 'cancel' })}>
                  Cancel
                </Button>
              }
            />
          ))}
        </ListGroup>
      )}

      <Sheet open={selected !== null} onClose={() => setSelected(null)} title={selected?.username} description={selected ? `Friends since ${new Date(selected.since).toLocaleDateString('en-KE', { month: 'short', year: 'numeric' })}` : undefined}>
        {selected && (
          <ListGroup>
            <ListRow leading={<IconTile icon={UserMinus} tone="neutral" size="sm" />} title="Remove friend" onClick={() => { setConfirm({ kind: 'remove', user: selected }); setSelected(null); }} />
            <ListRow leading={<IconTile icon={UserX} tone="danger" size="sm" />} title="Block" subtitle="You won’t see each other anywhere" onClick={() => { setConfirm({ kind: 'block', user: selected }); setSelected(null); }} />
            <ListRow
              leading={<IconTile icon={Flag} tone="warning" size="sm" />}
              title="Report"
              onClick={() => {
                setReportTarget(selected);
                setSelected(null);
              }}
            />
          </ListGroup>
        )}
      </Sheet>

      <Sheet
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === 'block' ? `Block ${confirm.user.username}?` : `Remove ${confirm?.user.username}?`}
        description={
          confirm?.kind === 'block'
            ? 'You’ll stop being friends and won’t see each other in search, rankings, teams or the feed. They aren’t told.'
            : 'You’ll no longer see each other in your friends ranking or feed. They aren’t told.'
        }
        footer={
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              Keep
            </Button>
            <Button variant="danger" isLoading={act.isPending} onClick={() => confirm && act.mutate(confirm)}>
              {confirm?.kind === 'block' ? 'Block' : 'Remove'}
            </Button>
          </div>
        }
      >
        <span />
      </Sheet>

      <ReportSheet open={reportTarget !== null} onClose={() => setReportTarget(null)} target={reportTarget ? { type: 'user', id: reportTarget.id, name: reportTarget.username } : null} />
    </div>
  );
}

export default FriendsTab;
