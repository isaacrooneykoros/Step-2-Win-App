import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  FileText,
  LifeBuoy,
  Medal,
  RefreshCw,
  Ruler,
  Scale,
  Settings,
  Smartphone,
} from 'lucide-react';
import { authService, stepsService } from '../services/api';
import { useAuthStore } from '../store/authStore';
import type { User } from '../types';
import { ScreenHeader, IconButton } from '../components/ui/ScreenHeader';
import { SectionHeader } from '../components/ui/Card';
import Card from '../components/ui/Card';
import { Avatar } from '../components/ui/Avatar';
import { IconTile, Pill } from '../components/ui/Pill';
import { ListGroup, ListRow } from '../components/ui/ListRow';
import { Skeleton } from '../components/ui/Skeleton';
import { ErrorInline } from '../components/ui/ErrorState';
import { StepBarChart, type StepBar } from '../components/steps/StepBarChart';
import { dayLabel, relativeDayLabel, useDailyGoal, weekdayShort } from '../components/steps/stepUtils';
import { AchievementsGrid, useAchievements } from '../components/profile/Achievements';
import { calibrationSummary, dailySeries, memberSinceLabel, periodStats, standingInfo } from '../components/profile/profileModel';
import { formatKES, formatSteps } from '../lib/format';

// Same slugs and wording as Settings; the legal screen handles unpublished documents.
const LEGAL_DOCS = [
  { slug: 'terms-and-conditions', title: 'Terms of service', icon: Scale },
  { slug: 'privacy-policy', title: 'Privacy policy', icon: FileText },
];

export default function ProfileScreen() {
  const navigate = useNavigate();
  const storeUser = useAuthStore((s) => s.user);
  const profileQuery = useQuery<User>({ queryKey: ['profile'], queryFn: authService.getProfile });
  const user = (profileQuery.data ?? storeUser) as User | null;
  const achievements = useAchievements();

  const memberSince = memberSinceLabel(user);
  const standing = standingInfo(user);
  const calibration = calibrationSummary(user);

  return (
    <div className="pb-nav">
      <ScreenHeader
        variant="large"
        title="Profile"
        actions={
          <IconButton label="Settings" onClick={() => navigate('/settings')}>
            <Settings size={22} strokeWidth={1.9} />
          </IconButton>
        }
      />

      <div className="space-y-6 px-5">
        {/* Identity */}
        {user ? (
          <section aria-label="Your profile" className="flex items-center gap-4">
            <Link to="/settings" aria-label="Change profile photo in Settings" className="shrink-0 rounded-full active:!scale-100">
              <Avatar name={user.username} src={user.profile_picture_url} size="xl" />
            </Link>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-title text-text-primary">{user.username}</h2>
              {memberSince && <p className="mt-0.5 text-callout text-text-secondary">Member since {memberSince}</p>}
              {user.player_rank && (
                <Pill tone="brand" icon={Medal} size="md" className="mt-2">
                  {user.player_rank}
                </Pill>
              )}
            </div>
          </section>
        ) : (
          <IdentitySkeleton />
        )}

        {/* Stat strip */}
        {user ? (
          <section aria-label="Key stats" className="grid grid-cols-3 divide-x divide-border-light rounded-card border border-border-light bg-bg-card py-4 shadow-card">
            <Stat label="Total steps" value={formatSteps(user.total_steps)} />
            <Stat
              label="Streak"
              value={
                <>
                  {user.current_streak}
                  <span className="text-callout font-medium text-text-muted"> {user.current_streak === 1 ? 'day' : 'days'}</span>
                </>
              }
              hint={`Best ${user.best_streak}`}
            />
            <Stat
              label="Challenges won"
              value={
                <>
                  {user.challenges_won}
                  <span className="text-callout font-medium text-text-muted"> of {user.challenges_joined}</span>
                </>
              }
              hint={user.challenges_joined ? `${Math.round(user.win_rate || 0)}% win rate` : 'None joined yet'}
            />
          </section>
        ) : (
          <Skeleton className="h-[92px] rounded-card" />
        )}
        {profileQuery.isError && !user && <ErrorInline message="We couldn't load your profile." onRetry={() => profileQuery.refetch()} />}

        {/* Activity */}
        <section>
          <SectionHeader title="Your activity" subtitle="Last 7 days" action={{ label: 'See insights', to: '/profile/analytics' }} />
          <WeekActivity />
        </section>

        {/* Achievements */}
        <section>
          <SectionHeader
            title="Achievements"
            subtitle={achievements.isLoading ? undefined : `${achievements.earned.length} of ${achievements.total} earned`}
          />
          <Card padding="lg">
            <AchievementsGrid data={achievements} limit={8} />
          </Card>
        </section>

        {/* Earnings */}
        {user && (
          <section>
            <SectionHeader title="Earnings" action={{ label: 'Wallet', to: '/wallet' }} />
            <Card padding="lg">
              <p className="text-caption text-text-muted">Total earned from challenges</p>
              <p className="num mt-1 text-title-lg text-reward-ink">{formatKES(user.total_earned)}</p>
              <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border-light pt-4">
                <div>
                  <dt className="text-caption text-text-muted">Win rate</dt>
                  <dd className="num mt-0.5 text-headline text-text-primary">{Math.round(user.win_rate || 0)}%</dd>
                </div>
                <div>
                  <dt className="text-caption text-text-muted">Average payout</dt>
                  <dd className="num mt-0.5 text-headline text-text-primary">{formatKES(user.avg_payout_kes)}</dd>
                </div>
              </dl>
            </Card>
          </section>
        )}

        {/* Standing */}
        {user && (
          <ListGroup title="Account standing">
            <ListRow
              leading={<IconTile icon={standing.icon} tone={standing.tone} size="sm" />}
              title="Account status"
              trailing={<Pill tone={standing.tone}>{standing.label}</Pill>}
            />
            {!standing.ok && (
              <div className="px-4 py-3 text-callout text-text-secondary">
                <p>{standing.description}</p>
                {user.moderation_message && <p className="mt-2 text-text-primary">{user.moderation_message}</p>}
                <Link to="/support" className="mt-2 inline-flex min-h-touch items-center gap-0.5 font-semibold text-brand">
                  Contact support <ChevronRight size={16} aria-hidden />
                </Link>
              </div>
            )}
            <ListRow
              to="/settings"
              leading={<IconTile icon={Ruler} tone={calibration.tone === 'warning' ? 'warning' : 'neutral'} size="sm" />}
              title="Stride calibration"
              subtitle={calibration.label}
            />
          </ListGroup>
        )}

        {/* Menu */}
        <ListGroup title="Account">
          <ListRow to="/settings" leading={<IconTile icon={Settings} tone="neutral" size="sm" />} title="Settings" subtitle="Profile, goals, notifications, security" />
          <ListRow to="/profile/sessions" leading={<IconTile icon={Smartphone} tone="neutral" size="sm" />} title="Active sessions" subtitle="Devices signed in to your account" />
        </ListGroup>

        <ListGroup title="Activity">
          <ListRow to="/settings/sync-outbox" leading={<IconTile icon={RefreshCw} tone="neutral" size="sm" />} title="Step sync & outbox" subtitle="Pending and failed step uploads" />
        </ListGroup>

        <ListGroup title="Help">
          <ListRow to="/support" leading={<IconTile icon={LifeBuoy} tone="neutral" size="sm" />} title="Support" subtitle="Get help with your account or payments" />
          {LEGAL_DOCS.map((doc) => (
            <ListRow key={doc.slug} to={`/legal/${doc.slug}`} leading={<IconTile icon={doc.icon} tone="neutral" size="sm" />} title={doc.title} />
          ))}
        </ListGroup>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 px-3 text-center">
      <p className="truncate text-caption text-text-muted">{label}</p>
      <p className="num mt-1 truncate text-headline text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 truncate text-caption text-text-muted">{hint}</p>}
    </div>
  );
}

function IdentitySkeleton() {
  return (
    <div className="flex items-center gap-4" aria-busy="true" aria-label="Loading profile">
      <Skeleton className="h-20 w-20 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-6 w-36 rounded" />
        <Skeleton className="h-4 w-28 rounded" />
        <Skeleton className="h-7 w-24 rounded-full" />
      </div>
    </div>
  );
}

/** Compact 7-day chart vs the daily goal, from real history. Missing days render as stubs, not zeros. */
function WeekActivity() {
  const { goal } = useDailyGoal();
  const history = useQuery({ queryKey: ['health', 'history', '1w'], queryFn: () => stepsService.getHistory('1w') });
  const [selected, setSelected] = useState<string | null>(null);

  if (history.isLoading) return <Skeleton className="h-[196px] rounded-card" />;
  if (history.isError) return <ErrorInline message="We couldn't load this week's steps." onRetry={() => history.refetch()} />;

  const points = dailySeries(history.data, 7);
  const stats = periodStats(points, goal);
  const activeKey = selected ?? points[points.length - 1].date;
  const active = points.find((p) => p.date === activeKey);

  const bars: StepBar[] = points.map((p, i) => ({
    key: p.date,
    value: p.steps,
    axisLabel: i === points.length - 1 ? 'Today' : weekdayShort(p.date).slice(0, 1),
    emphasis: i === points.length - 1,
    description:
      p.steps === null
        ? `${dayLabel(p.date)}: no data`
        : `${dayLabel(p.date)}: ${formatSteps(p.steps)} steps${p.steps >= goal ? ', goal met' : ''}`,
  }));

  return (
    <Card padding="lg">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-caption text-text-muted">Daily average</p>
          <p className="num text-title text-text-primary">{formatSteps(stats.avgSteps)}</p>
        </div>
        <p className="text-right text-callout text-text-secondary">
          Goal met <span className="num font-semibold text-text-primary">{stats.goalDays}</span> of {points.length} days
        </p>
      </div>
      <div className="mt-4 flex h-5 items-center justify-between text-caption" aria-live="polite">
        {active && (
          <>
            <span className="text-text-secondary">{relativeDayLabel(active.date)}</span>
            <span className="num font-semibold text-text-primary">{active.steps === null ? 'No data' : `${formatSteps(active.steps)} steps`}</span>
          </>
        )}
      </div>
      <StepBarChart
        className="mt-2"
        bars={bars}
        goal={goal}
        height={96}
        label={`Steps over the last 7 days. Average ${formatSteps(stats.avgSteps)} a day; goal of ${formatSteps(goal)} met on ${stats.goalDays} days.`}
        selectedKey={activeKey}
        onSelect={setSelected}
      />
    </Card>
  );
}
