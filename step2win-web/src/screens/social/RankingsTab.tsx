import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Award, Info, Trophy, UserPlus, Users } from 'lucide-react';
import { Segmented } from '../../components/ui/Segmented';
import { EmptyState } from '../../components/ui/EmptyState';
import { LoadError } from '../../components/ui/ErrorState';
import { IconTile } from '../../components/ui/Pill';
import { Movement, RankListSkeleton, RankRow } from '../../components/social/RankList';
import { socialService, type WeekParam } from '../../services/api/social';
import { usePollInterval } from '../../hooks/useDataSaver';
import { formatSteps } from '../../lib/format';
import { RANKING_POLL_MS, ordinal, socialKeys, weekRangeLabel } from '../../components/social/socialUtils';

type Scope = 'friends' | 'teams';

export function RankingsTab({ teamsEnabled }: { teamsEnabled: boolean }) {
  const navigate = useNavigate();
  const [scope, setScope] = useState<Scope>('friends');
  const [week, setWeek] = useState<WeekParam>('current');
  const poll = usePollInterval(week === 'current' ? RANKING_POLL_MS : false);

  const friendsQuery = useQuery({
    queryKey: socialKeys.friendsRanking(week),
    queryFn: () => socialService.friendsRanking(week),
    enabled: scope === 'friends',
    refetchInterval: poll,
    staleTime: 60_000,
  });
  const teamsQuery = useQuery({
    queryKey: socialKeys.teamsRanking(week),
    queryFn: () => socialService.teamsRanking(week),
    enabled: scope === 'teams' && teamsEnabled,
    refetchInterval: poll,
    staleTime: 60_000,
  });
  const historyQuery = useQuery({ queryKey: socialKeys.history, queryFn: socialService.history, staleTime: 10 * 60_000 });

  const board = friendsQuery.data;
  const me = board?.me;
  const range = board ? weekRangeLabel(board.week_start, board.week_end) : teamsQuery.data ? weekRangeLabel(teamsQuery.data.week_start, teamsQuery.data.week_end) : '';

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2">
        {teamsEnabled ? (
          <Segmented<Scope>
            label="Ranking"
            size="sm"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'friends', label: 'Friends' },
              { value: 'teams', label: 'Teams' },
            ]}
          />
        ) : (
          <span />
        )}
        <Segmented<WeekParam>
          label="Week"
          size="sm"
          value={week}
          onChange={setWeek}
          options={[
            { value: 'current', label: 'This week' },
            { value: 'previous', label: 'Last week' },
          ]}
        />
      </div>

      {scope === 'friends' ? (
        friendsQuery.isLoading ? (
          <RankListSkeleton />
        ) : friendsQuery.isError ? (
          <LoadError resource="the ranking" onRetry={() => friendsQuery.refetch()} isRetrying={friendsQuery.isFetching} />
        ) : board && board.size <= 1 ? (
          <EmptyState
            icon={UserPlus}
            title="Rank with your friends"
            description="Add friends to see who walks the most each week. It’s just for fun: no money involved."
            action={{ label: 'Add friends', onClick: () => navigate('/social/add') }}
          />
        ) : board ? (
          <>
            {me && (
              <section aria-label="Your position" className="rounded-card border border-border-light bg-bg-card p-4 shadow-card">
                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-2xl bg-brand-soft text-brand">
                    <span className="num text-title leading-none">{me.rank}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-headline text-text-primary">
                      You’re {ordinal(me.rank)} of {board.size}
                    </p>
                    <p className="num mt-0.5 text-callout text-text-secondary">{formatSteps(me.steps)} steps · {range}</p>
                  </div>
                  <Movement value={me.movement} />
                </div>
              </section>
            )}
            <div className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light bg-bg-card shadow-card">
              {board.rows.map((row) => (
                <RankRow
                  key={row.user.id}
                  rank={row.steps > 0 ? row.rank : null}
                  name={row.user.username}
                  photo={row.user.profile_picture_url}
                  steps={row.steps}
                  movement={row.movement}
                  highlight={row.is_me}
                  subtitle={row.days_counted > 0 ? `${row.days_counted} ${row.days_counted === 1 ? 'day' : 'days'} walked` : 'No steps yet'}
                />
              ))}
            </div>
          </>
        ) : null
      ) : teamsQuery.isLoading ? (
        <RankListSkeleton />
      ) : teamsQuery.isError ? (
        <LoadError resource="the team ranking" onRetry={() => teamsQuery.refetch()} isRetrying={teamsQuery.isFetching} />
      ) : teamsQuery.data && teamsQuery.data.rows.length === 0 && teamsQuery.data.mine.length === 0 ? (
        <EmptyState icon={Users} title="No team steps yet" description="Join or create a team and walk together. Team totals appear here within a few minutes." />
      ) : teamsQuery.data ? (
        <>
          {teamsQuery.data.mine.length > 0 && (
            <section aria-label="Your teams">
              <h2 className="eyebrow mb-2 px-1">Your teams</h2>
              <div className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light bg-bg-card shadow-card">
                {teamsQuery.data.mine.map((row) => (
                  <RankRow
                    key={row.team.id}
                    rank={row.rank}
                    name={row.team.name}
                    steps={row.steps}
                    movement={row.movement}
                    highlight
                    leading={<IconTile icon={Users} tone="brand" />}
                    subtitle={`${row.members_counted} of ${row.team.member_count} walking`}
                    onClick={() => navigate(`/social/teams/${row.team.id}`)}
                  />
                ))}
              </div>
            </section>
          )}
          <section aria-label="Top teams">
            <h2 className="eyebrow mb-2 px-1">Top teams · {range}</h2>
            <div className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light bg-bg-card shadow-card">
              {teamsQuery.data.rows.map((row) => (
                <RankRow
                  key={row.team.id}
                  rank={row.rank}
                  name={row.team.name}
                  steps={row.steps}
                  movement={row.movement}
                  leading={<IconTile icon={Users} tone={row.is_mine ? 'brand' : 'neutral'} />}
                  subtitle={`${row.team.member_count} ${row.team.member_count === 1 ? 'member' : 'members'}`}
                  onClick={row.team.visibility === 'public' || row.is_mine ? () => navigate(`/social/teams/${row.team.id}`) : undefined}
                />
              ))}
            </div>
          </section>
        </>
      ) : null}

      {historyQuery.data && historyQuery.data.friends_wins > 0 && (
        <div className="flex items-center gap-3 rounded-card bg-bg-sunken p-4">
          <IconTile icon={Trophy} tone="brand" size="sm" />
          <p className="text-callout text-text-secondary">
            You’ve topped your friends’ ranking <span className="font-semibold text-text-primary">{historyQuery.data.friends_wins}</span>{' '}
            {historyQuery.data.friends_wins === 1 ? 'week' : 'weeks'}.
          </p>
          <Award size={18} className="ml-auto shrink-0 text-brand" aria-hidden />
        </div>
      )}

      <p className="flex gap-2 px-1 text-caption text-text-muted">
        <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          Weeks run Monday to Sunday (Kenya time). Your counted steps are used, and days under review don’t count. Rankings are for
          bragging rights only: there’s no money or prize.
        </span>
      </p>
    </div>
  );
}

export default RankingsTab;
