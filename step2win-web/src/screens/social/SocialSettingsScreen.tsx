import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Award, Bell, EyeOff, Flame, Footprints, Globe, KeyRound, Target, Trophy, UserCheck, Users } from 'lucide-react';
import { ScreenHeader } from '../../components/ui/ScreenHeader';
import { ListGroup, ListRow } from '../../components/ui/ListRow';
import { IconTile } from '../../components/ui/Pill';
import { Avatar } from '../../components/ui/Avatar';
import Button from '../../components/ui/Button';
import { Sheet } from '../../components/ui/Sheet';
import { Skeleton } from '../../components/ui/Skeleton';
import { LoadError } from '../../components/ui/ErrorState';
import { useToast } from '../../components/ui/Toast';
import { ToggleRow } from '../../components/settings/Switch';
import { apiErrorMessage } from '../../components/settings/apiError';
import { socialService, type Discoverability, type SocialMe, type SocialSettingsPatch } from '../../services/api/social';
import { socialKeys } from '../../components/social/socialUtils';

const DISCOVER: Array<{ value: Discoverability; title: string; subtitle: string; icon: typeof Globe }> = [
  { value: 'everyone', title: 'Everyone', subtitle: 'Anyone can find you by username', icon: Globe },
  { value: 'friends_of_friends', title: 'Friends of friends', subtitle: 'Only people who share a friend with you', icon: Users },
  { value: 'nobody', title: 'Nobody', subtitle: 'Only people you give your code or QR', icon: EyeOff },
];

export default function SocialSettingsScreen() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [resetOpen, setResetOpen] = useState(false);
  const me = useQuery({ queryKey: socialKeys.me, queryFn: socialService.me, staleTime: 60_000 });
  const blocks = useQuery({ queryKey: socialKeys.blocks, queryFn: socialService.blocks, staleTime: 60_000 });

  const update = useMutation({
    mutationFn: (patch: SocialSettingsPatch) => socialService.updateMe(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: socialKeys.me });
      const previous = queryClient.getQueryData<SocialMe>(socialKeys.me);
      if (previous) queryClient.setQueryData(socialKeys.me, { ...previous, ...patch });
      return { previous };
    },
    onError: (error, _p, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(socialKeys.me, ctx.previous);
      showToast({ message: apiErrorMessage(error, 'Couldn’t save that setting.'), type: 'error' });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(socialKeys.me, data);
      queryClient.invalidateQueries({ queryKey: ['social', 'ranking'] });
    },
  });

  const unblock = useMutation({
    mutationFn: (id: number) => socialService.unblock(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: socialKeys.all });
      showToast({ message: 'Unblocked. You can find each other again.', type: 'success' });
    },
    onError: (error) => showToast({ message: apiErrorMessage(error, 'Couldn’t unblock. Please try again.'), type: 'error' }),
  });

  const reset = useMutation({
    mutationFn: socialService.resetFriendCode,
    onSuccess: ({ friend_code }) => {
      const previous = queryClient.getQueryData<SocialMe>(socialKeys.me);
      if (previous) queryClient.setQueryData(socialKeys.me, { ...previous, friend_code });
      setResetOpen(false);
      showToast({ message: `Your new code is ${friend_code}. Old links and QR codes no longer work.`, type: 'success' });
    },
    onError: (error) => showToast({ message: apiErrorMessage(error, 'Couldn’t change your code.'), type: 'error' }),
  });

  const s = me.data;
  const set = (patch: SocialSettingsPatch) => update.mutate(patch);

  return (
    <div className="pb-nav">
      <ScreenHeader title="Friends settings" back="/social" />
      <div className="mx-auto w-full max-w-2xl space-y-6 px-5 pb-8 pt-2">
        {me.isLoading ? (
          <div className="space-y-4" aria-busy="true">
            <Skeleton className="h-44 rounded-card" />
            <Skeleton className="h-60 rounded-card" />
          </div>
        ) : me.isError || !s ? (
          <LoadError resource="your settings" onRetry={() => me.refetch()} isRetrying={me.isFetching} />
        ) : (
          <>
            <ListGroup title="Who can find me by username" footer="Your friend code, link and QR always work for the people you share them with.">
              <div role="radiogroup" aria-label="Who can find me">
                {DISCOVER.map((opt) => {
                  const checked = s.discoverability === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      onClick={() => set({ discoverability: opt.value })}
                      className="flex min-h-[60px] w-full items-center gap-3 border-b border-border-light px-4 py-3 text-left last:border-b-0 hover:bg-bg-input/60 active:!scale-100"
                    >
                      <IconTile icon={opt.icon} tone={checked ? 'brand' : 'neutral'} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-body font-medium text-text-primary">{opt.title}</span>
                        <span className="mt-0.5 block text-caption text-text-muted">{opt.subtitle}</span>
                      </span>
                      <span
                        aria-hidden
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${checked ? 'border-brand' : 'border-border'}`}
                      >
                        {checked && <span className="h-2.5 w-2.5 rounded-full bg-brand" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </ListGroup>

            <ListGroup title="What friends see" footer="Only milestones are ever shared. Never your location, routes or wallet.">
              <ToggleRow leading={<IconTile icon={Target} tone="neutral" size="sm" />} title="Daily goal reached" checked={s.share_goal_hits} onChange={(v) => set({ share_goal_hits: v })} />
              <ToggleRow leading={<IconTile icon={Flame} tone="neutral" size="sm" />} title="Streak milestones" checked={s.share_streaks} onChange={(v) => set({ share_streaks: v })} />
              <ToggleRow leading={<IconTile icon={Award} tone="neutral" size="sm" />} title="Badges earned" checked={s.share_badges} onChange={(v) => set({ share_badges: v })} />
              <ToggleRow leading={<IconTile icon={Footprints} tone="neutral" size="sm" />} title="Challenge milestones" subtitle="No challenge names or amounts" checked={s.share_challenges} onChange={(v) => set({ share_challenges: v })} />
              <ToggleRow
                leading={<IconTile icon={Trophy} tone="neutral" size="sm" />}
                title="Show me in rankings"
                subtitle="Off: you still see rankings, but friends and teammates don’t see you"
                checked={s.show_in_rankings}
                onChange={(v) => set({ show_in_rankings: v })}
              />
            </ListGroup>

            <ListGroup title="Notify me about" footer="Alerts on your phone also need Push notifications on in Settings.">
              <ToggleRow leading={<IconTile icon={UserCheck} tone="neutral" size="sm" />} title="Friend requests" checked={s.notify_friend_requests} onChange={(v) => set({ notify_friend_requests: v })} />
              <ToggleRow leading={<IconTile icon={Trophy} tone="neutral" size="sm" />} title="Weekly results" subtitle="Monday, when last week’s rankings close" checked={s.notify_weekly_results} onChange={(v) => set({ notify_weekly_results: v })} />
              <ToggleRow leading={<IconTile icon={Bell} tone="neutral" size="sm" />} title="Reactions" subtitle="When friends cheer your milestones" checked={s.notify_reactions} onChange={(v) => set({ notify_reactions: v })} />
            </ListGroup>

            <ListGroup title="Friend code">
              <ListRow leading={<IconTile icon={KeyRound} tone="neutral" size="sm" />} title={<span className="num tracking-[0.12em]">{s.friend_code}</span>} subtitle="Change it if it was shared too widely" onClick={() => setResetOpen(true)} chevron />
            </ListGroup>

            <ListGroup title="Blocked people" footer="Blocked people can’t find you, add you or see you in rankings, teams or activity. They aren’t told.">
              {blocks.isLoading ? (
                <div className="p-4"><Skeleton className="h-6 rounded" /></div>
              ) : (blocks.data ?? []).length === 0 ? (
                <p className="px-4 py-4 text-callout text-text-muted">You haven’t blocked anyone.</p>
              ) : (
                (blocks.data ?? []).map((b) => (
                  <ListRow
                    key={b.id}
                    leading={<Avatar name={b.username} src={b.profile_picture_url} size="sm" />}
                    title={b.username}
                    trailing={
                      <Button size="sm" variant="ghost" disabled={unblock.isPending} onClick={() => unblock.mutate(b.id)}>
                        Unblock
                      </Button>
                    }
                  />
                ))
              )}
            </ListGroup>
          </>
        )}
      </div>

      <Sheet
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Change your friend code?"
        description="Links and QR codes you’ve already shared will stop working. Your friends stay your friends."
        footer={
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setResetOpen(false)}>Keep</Button>
            <Button isLoading={reset.isPending} onClick={() => reset.mutate()}>Change code</Button>
          </div>
        }
      >
        <span />
      </Sheet>
    </div>
  );
}
