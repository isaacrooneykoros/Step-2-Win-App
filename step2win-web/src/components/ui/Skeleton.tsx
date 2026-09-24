/**
 * Unified Skeleton Components for Loading States
 *
 * These components provide content-aware loading placeholders
 * that match the actual content they replace, preventing layout shifts.
 */

import { ReactNode } from 'react';

interface SkeletonProps {
  className?: string;
  style?: React.CSSProperties;
}

// Base skeleton with shimmer animation (defined in index.css)
export function Skeleton({ className = '', style }: SkeletonProps) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden="true" />;
}

// Text placeholder - single line
export function SkeletonText({
  width = 'w-full',
  height = 'h-4',
  className = ''
}: {
  width?: string;
  height?: string;
  className?: string;
}) {
  return <Skeleton className={`${width} ${height} rounded ${className}`} />;
}

// Avatar/profile picture placeholder
export function SkeletonAvatar({
  size = 'md',
  className = ''
}: {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const sizes = {
    sm: 'w-8 h-8',
    md: 'w-10 h-10',
    lg: 'w-12 h-12',
    xl: 'w-16 h-16',
  };
  return <Skeleton className={`${sizes[size]} rounded-full shrink-0 ${className}`} />;
}

// Card container placeholder
export function SkeletonCard({
  children,
  className = ''
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`card p-4 ${className}`}>
      {children || (
        <>
          <SkeletonText width="w-24" className="mb-3" />
          <SkeletonText width="w-full" className="mb-2" />
          <SkeletonText width="w-3/4" />
        </>
      )}
    </div>
  );
}

// Challenge card skeleton
export function SkeletonChallengeCard({ className = '' }: { className?: string }) {
  return (
    <div className={`card p-4 ${className}`}>
      <div className="flex items-center gap-3 mb-3">
        <Skeleton className="w-12 h-12 rounded-2xl shrink-0" />
        <div className="flex-1">
          <SkeletonText width="w-32" height="h-5" className="mb-2" />
          <SkeletonText width="w-24" height="h-3" />
        </div>
      </div>
      <div className="flex items-center gap-2 mb-3">
        <Skeleton className="w-16 h-6 rounded-full" />
        <Skeleton className="w-20 h-6 rounded-full" />
      </div>
      <Skeleton className="w-full h-2 rounded-full mb-2" />
      <div className="flex justify-between">
        <SkeletonText width="w-16" height="h-3" />
        <SkeletonText width="w-12" height="h-3" />
      </div>
    </div>
  );
}

// Leaderboard row skeleton
export function SkeletonLeaderboardRow({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-3 py-3 ${className}`}>
      <Skeleton className="w-6 h-6 rounded-full shrink-0" />
      <SkeletonAvatar size="md" />
      <div className="flex-1">
        <SkeletonText width="w-24" height="h-4" className="mb-1" />
        <SkeletonText width="w-16" height="h-3" />
      </div>
      <SkeletonText width="w-16" height="h-5" />
    </div>
  );
}

// Transaction row skeleton
export function SkeletonTransaction({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-3 py-3 ${className}`}>
      <Skeleton className="w-10 h-10 rounded-xl shrink-0" />
      <div className="flex-1">
        <SkeletonText width="w-32" height="h-4" className="mb-1" />
        <SkeletonText width="w-24" height="h-3" />
      </div>
      <div className="text-right">
        <SkeletonText width="w-16" height="h-4" className="mb-1 ml-auto" />
        <Skeleton className="w-14 h-5 rounded-full ml-auto" />
      </div>
    </div>
  );
}

// Step stat card skeleton
export function SkeletonStatCard({ className = '' }: { className?: string }) {
  return (
    <div className={`card p-4 ${className}`}>
      <div className="flex items-center gap-2 mb-2">
        <Skeleton className="w-8 h-8 rounded-lg shrink-0" />
        <SkeletonText width="w-20" height="h-3" />
      </div>
      <SkeletonText width="w-24" height="h-7" className="mb-1" />
      <SkeletonText width="w-16" height="h-3" />
    </div>
  );
}

// Profile header skeleton
export function SkeletonProfile({ className = '' }: { className?: string }) {
  return (
    <div className={`text-center ${className}`}>
      <SkeletonAvatar size="xl" className="mx-auto mb-3" />
      <SkeletonText width="w-32" height="h-6" className="mx-auto mb-2" />
      <SkeletonText width="w-24" height="h-4" className="mx-auto mb-4" />
      <div className="flex justify-center gap-6">
        <div className="text-center">
          <SkeletonText width="w-12" height="h-5" className="mx-auto mb-1" />
          <SkeletonText width="w-16" height="h-3" className="mx-auto" />
        </div>
        <div className="text-center">
          <SkeletonText width="w-12" height="h-5" className="mx-auto mb-1" />
          <SkeletonText width="w-16" height="h-3" className="mx-auto" />
        </div>
        <div className="text-center">
          <SkeletonText width="w-12" height="h-5" className="mx-auto mb-1" />
          <SkeletonText width="w-16" height="h-3" className="mx-auto" />
        </div>
      </div>
    </div>
  );
}

// Wallet balance skeleton
export function SkeletonWalletBalance({ className = '' }: { className?: string }) {
  return (
    <div className={`${className}`}>
      <SkeletonText width="w-20" height="h-3" className="mb-2" />
      <SkeletonText width="w-32" height="h-10" className="mb-3" />
      <div className="flex gap-3">
        <Skeleton className="flex-1 h-12 rounded-2xl" />
        <Skeleton className="flex-1 h-12 rounded-2xl" />
      </div>
    </div>
  );
}

// Steps progress circle skeleton
export function SkeletonStepsProgress({ className = '' }: { className?: string }) {
  return (
    <div className={`flex flex-col items-center ${className}`}>
      <Skeleton className="w-40 h-40 rounded-full mb-4" />
      <SkeletonText width="w-24" height="h-8" className="mb-2" />
      <SkeletonText width="w-32" height="h-4" />
    </div>
  );
}

// Weekly steps bar chart skeleton
export function SkeletonWeeklyChart({ className = '' }: { className?: string }) {
  return (
    <div className={`card p-4 ${className}`}>
      <SkeletonText width="w-24" height="h-4" className="mb-4" />
      <div className="flex items-end justify-between gap-2 h-24">
        {[0.4, 0.7, 0.5, 0.9, 0.6, 0.8, 0.3].map((h, i) => (
          <Skeleton
            key={i}
            className="flex-1 rounded-t"
            style={{ height: `${h * 100}%` }}
          />
        ))}
      </div>
      <div className="flex justify-between mt-2">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span key={i} className="text-xs text-text-muted flex-1 text-center">{d}</span>
        ))}
      </div>
    </div>
  );
}

// Admin table skeleton
export function SkeletonTable({
  rows = 5,
  columns = 4,
  className = ''
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div className={`${className}`}>
      {/* Header */}
      <div className="flex gap-4 py-3 border-b border-border">
        {Array.from({ length: columns }).map((_, i) => (
          <SkeletonText
            key={i}
            width={i === 0 ? 'w-32' : 'w-20'}
            height="h-3"
          />
        ))}
      </div>
      {/* Rows */}
      {Array.from({ length: rows }).map((_, rowIdx) => (
        <div key={rowIdx} className="flex gap-4 py-4 border-b border-border/50">
          {Array.from({ length: columns }).map((_, colIdx) => (
            <SkeletonText
              key={colIdx}
              width={colIdx === 0 ? 'w-32' : 'w-20'}
              height="h-4"
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// Button loading state (inline)
export function ButtonLoader({ className = '' }: { className?: string }) {
  return (
    <div
      className={`w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
}

// Inline loader for partial content
export function InlineLoader({
  text = 'Loading...',
  className = ''
}: {
  text?: string;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2 text-text-secondary ${className}`}>
      <ButtonLoader />
      <span className="text-sm">{text}</span>
    </div>
  );
}

// Full page skeleton for screen transitions
export function ScreenSkeleton({
  children,
  className = ''
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`screen-enter pb-nav ${className}`}>
      {children}
    </div>
  );
}
