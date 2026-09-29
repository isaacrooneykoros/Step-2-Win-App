import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Route } from 'lucide-react';
import { stepsService } from '../../services/api/steps';
import { hasNativeStepCounter } from '../../utils/platform';
import { ListGroup, ListRow } from '../ui/ListRow';
import { IconTile, Pill } from '../ui/Pill';
import { Skeleton } from '../ui/Skeleton';
import { formatDistance, formatDuration, formatWalkDate } from './walkFormat';

/** The last few walks (newest first). Renders nothing until there is at least one. */
export function RecentWalks({ limit = 5 }: { limit?: number }) {
  const walks = useQuery({
    queryKey: ['walks', 'list', limit],
    queryFn: () => stepsService.listWalks(limit),
    enabled: hasNativeStepCounter(),
    staleTime: 60_000,
  });

  if (walks.isLoading && hasNativeStepCounter()) {
    return <Skeleton className="h-16 w-full rounded-card" />;
  }
  const list = (walks.data ?? []).filter((w) => w.status !== 'active');
  if (list.length === 0) return null;

  return (
    <ListGroup title="Recent walks">
      {list.map((walk) => (
        <ListRow
          key={String(walk.id)}
          to={`/walks/${encodeURIComponent(String(walk.id))}`}
          leading={<IconTile icon={Route} tone={walk.verdict === 'verified' ? 'success' : 'neutral'} size="sm" />}
          title={formatWalkDate(walk.started_at)}
          subtitle={
            <span className="num">
              {formatDistance(walk.distance_m)} · {formatDuration(walk.duration_s)}
            </span>
          }
          trailing={
            walk.verdict === 'verified' ? (
              <Pill tone="success" icon={CheckCircle2}>
                Verified
              </Pill>
            ) : walk.verdict === 'pending' ? (
              <Pill tone="neutral">Checking</Pill>
            ) : null
          }
        />
      ))}
    </ListGroup>
  );
}

export default RecentWalks;
