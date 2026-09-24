import { Skeleton } from '../ui/Skeleton';
import { LeaderboardSkeleton } from './Leaderboard';

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="divide-y divide-border-light overflow-hidden rounded-card border border-border-light bg-bg-card">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex min-h-[56px] items-center justify-between gap-3 px-4 py-3">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3.5 w-20" />
        </div>
      ))}
    </div>
  );
}

export function ChallengeDetailSkeleton() {
  return (
    <div className="space-y-8 px-5 pt-1" aria-busy="true" aria-label="Loading challenge">
      <div>
        <div className="flex gap-1.5">
          <Skeleton className="h-6 w-14 rounded-full" />
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-6 w-24 rounded-full" />
        </div>
        <Skeleton className="mt-3 h-8 w-4/5" />
        <Skeleton className="mt-2 h-4 w-full" />
        <div className="mt-5 flex justify-between">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="mt-2 h-1.5 w-full rounded-full" />
      </div>
      <div>
        <Skeleton className="mb-3 h-5 w-40" />
        <div className="rounded-card border border-border-light bg-bg-card p-5">
          <div className="flex items-center gap-5">
            <Skeleton className="h-28 w-28 rounded-full" />
            <div className="flex-1">
              <Skeleton className="h-8 w-28" />
              <Skeleton className="mt-2 h-4 w-32" />
              <Skeleton className="mt-3 h-7 w-28 rounded-full" />
            </div>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-3 border-t border-border-light pt-4">
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <Skeleton className="h-3 w-12" />
                <Skeleton className="mt-2 h-5 w-16" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div>
        <Skeleton className="mb-3 h-5 w-32" />
        <LeaderboardSkeleton rows={5} />
      </div>
      <ListSkeleton rows={4} />
    </div>
  );
}

export function ResultsSkeleton() {
  return (
    <div className="space-y-8 px-5 pt-1" aria-busy="true" aria-label="Loading results">
      <div className="rounded-card border border-border-light bg-bg-card p-5">
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="mt-4 h-10 w-44" />
        <Skeleton className="mt-2 h-4 w-3/4" />
        <div className="mt-5 grid grid-cols-3 gap-3 border-t border-border-light pt-4">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <Skeleton className="h-3 w-12" />
              <Skeleton className="mt-2 h-5 w-16" />
            </div>
          ))}
        </div>
      </div>
      <ListSkeleton rows={4} />
      <div>
        <Skeleton className="mb-3 h-5 w-36" />
        <LeaderboardSkeleton rows={6} />
      </div>
    </div>
  );
}

export function SpectatorSkeleton() {
  return (
    <div className="space-y-8 px-5 pt-1" aria-busy="true" aria-label="Loading leaderboard">
      <div>
        <Skeleton className="h-6 w-14 rounded-full" />
        <Skeleton className="mt-3 h-8 w-4/5" />
        <div className="mt-5 grid grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i}>
              <Skeleton className="h-3 w-14" />
              <Skeleton className="mt-2 h-5 w-12" />
            </div>
          ))}
        </div>
      </div>
      <ListSkeleton rows={2} />
      <LeaderboardSkeleton rows={6} />
    </div>
  );
}
