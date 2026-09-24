import { CalendarClock, Flag, Trophy } from 'lucide-react';
import { Segmented } from '../../components/ui/Segmented';
import { EmptyState } from '../../components/ui/EmptyState';
import { ChallengeCard, ChallengeCardSkeleton } from '../../components/challenge/ChallengeCard';
import type { ChallengeCardModel } from '../../components/challenge/challengeUtils';

export type MineTab = 'active' | 'upcoming' | 'completed';

type Props = {
  isLoading: boolean;
  tab: MineTab;
  counts: Record<MineTab, number>;
  /** Challenges for the selected tab, already mapped to card models. */
  challenges: ChallengeCardModel[];
  onTabChange: (tab: MineTab) => void;
  onCreate: () => void;
  onDiscover: () => void;
};

const EMPTY: Record<MineTab, { icon: typeof Trophy; title: string; description: string }> = {
  active: {
    icon: Flag,
    title: 'No active challenges',
    description: 'Join a public challenge or start one with friends. Your progress will show here.',
  },
  upcoming: {
    icon: CalendarClock,
    title: 'Nothing coming up',
    description: "Challenges that haven't started yet, or still need players, will show here.",
  },
  completed: {
    icon: Trophy,
    title: 'No results yet',
    description: 'When a challenge you joined ends, your result and any payout will appear here.',
  },
};

export default function ChallengesMineSection({ isLoading, tab, counts, challenges, onTabChange, onCreate, onDiscover }: Props) {
  const empty = EMPTY[tab];
  const panelId = 'my-challenges-panel';

  return (
    <section aria-labelledby="my-challenges-heading">
      <h2 id="my-challenges-heading" className="sr-only">
        My challenges
      </h2>
      <Segmented
        label="Filter my challenges"
        value={tab}
        onChange={onTabChange}
        options={[
          { value: 'active', label: 'Active', count: isLoading ? undefined : counts.active },
          { value: 'upcoming', label: 'Upcoming', count: isLoading ? undefined : counts.upcoming },
          { value: 'completed', label: 'Completed', count: isLoading ? undefined : counts.completed },
        ]}
      />

      <div id={panelId} role="tabpanel" aria-label={`${tab} challenges`} className="mt-4" aria-busy={isLoading || undefined}>
        {isLoading ? (
          <div className="grid gap-3 md:grid-cols-2">
            <ChallengeCardSkeleton variant={tab === 'upcoming' ? 'upcoming' : tab} />
            <ChallengeCardSkeleton variant={tab === 'upcoming' ? 'upcoming' : tab} />
          </div>
        ) : challenges.length === 0 ? (
          <div className="rounded-card border border-dashed border-border">
            <EmptyState
              icon={empty.icon}
              title={empty.title}
              description={empty.description}
              action={{ label: 'Discover challenges', onClick: onDiscover }}
            />
            {tab === 'active' && (
              <div className="-mt-6 pb-8 text-center">
                <button type="button" onClick={onCreate} className="min-h-touch px-3 text-callout font-semibold text-brand">
                  Or create your own
                </button>
              </div>
            )}
          </div>
        ) : (
          <ul className="stagger grid gap-3 md:grid-cols-2">
            {challenges.map((c) => (
              <li key={c.id} className="min-w-0">
                <ChallengeCard variant={tab} challenge={c} to={`/challenges/${c.id}`} className="h-full" />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
