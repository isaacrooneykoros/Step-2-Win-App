import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bell, Settings2, Users } from 'lucide-react';
import { IconButton, ScreenHeader } from '../../components/ui/ScreenHeader';
import { Segmented } from '../../components/ui/Segmented';
import { EmptyState } from '../../components/ui/EmptyState';
import { LoadError } from '../../components/ui/ErrorState';
import { Skeleton } from '../../components/ui/Skeleton';
import { socialService } from '../../services/api/social';
import { socialKeys } from '../../components/social/socialUtils';
import RankingsTab from './RankingsTab';
import FeedTab from './FeedTab';
import FriendsTab from './FriendsTab';
import TeamsTab from './TeamsTab';

type Tab = 'rankings' | 'feed' | 'friends' | 'teams';
const TABS: Tab[] = ['rankings', 'feed', 'friends', 'teams'];

/** Friends & teams hub: weekly rankings, friends' milestones, friends, teams. */
export default function SocialScreen() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') as Tab | null;
  const meQuery = useQuery({ queryKey: socialKeys.me, queryFn: socialService.me, staleTime: 60_000 });
  const summary = useQuery({ queryKey: socialKeys.summary, queryFn: socialService.notificationSummary, staleTime: 60_000 });

  const features = meQuery.data?.features;
  const available = TABS.filter((t) => (t === 'feed' ? features?.feed !== false : t === 'teams' ? features?.teams !== false : true));
  const tab: Tab = requested && available.includes(requested) ? requested : 'rankings';
  const setTab = (next: Tab) => setParams(next === 'rankings' ? {} : { tab: next }, { replace: true });
  const incoming = meQuery.data?.incoming_requests ?? 0;
  const unread = summary.data?.unread ?? 0;

  const labels: Record<Tab, string> = { rankings: 'Rankings', feed: 'Activity', friends: 'Friends', teams: 'Teams' };

  return (
    <div className="pb-nav">
      <ScreenHeader
        title="Friends & teams"
        actions={
          <>
            <IconButton label={unread ? `Updates, ${unread} unread` : 'Updates'} onClick={() => navigate('/social/inbox')}>
              <Bell size={20} aria-hidden />
              {unread > 0 && <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-danger" aria-hidden />}
            </IconButton>
            <IconButton label="Privacy and settings" onClick={() => navigate('/social/settings')}>
              <Settings2 size={20} aria-hidden />
            </IconButton>
          </>
        }
      />
      <div className="mx-auto w-full max-w-2xl space-y-5 px-5 pb-8 pt-2">
        {meQuery.isLoading ? (
          <div className="space-y-4" aria-busy="true">
            <Skeleton className="h-9 rounded-control" />
            <Skeleton className="h-24 rounded-card" />
            <Skeleton className="h-64 rounded-card" />
          </div>
        ) : meQuery.isError ? (
          <LoadError resource="Friends & teams" onRetry={() => meQuery.refetch()} isRetrying={meQuery.isFetching} />
        ) : features && !features.social ? (
          <EmptyState icon={Users} title="Friends & teams are paused" description="We’ve switched this off for a little while. Your friends and teams are safe and will be back soon." />
        ) : (
          <>
            <Segmented<Tab>
              label="Friends and teams"
              value={tab}
              onChange={setTab}
              size="sm"
              options={available.map((t) => ({ value: t, label: labels[t], count: t === 'friends' ? incoming : undefined }))}
            />
            <div role="tabpanel" aria-label={labels[tab]}>
              {tab === 'rankings' && <RankingsTab teamsEnabled={features?.teams !== false} />}
              {tab === 'feed' && <FeedTab />}
              {tab === 'friends' && <FriendsTab />}
              {tab === 'teams' && <TeamsTab maxTeams={features?.max_teams_per_user ?? 3} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
