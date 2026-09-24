/**
 * Empty State Components
 *
 * Contextual empty states that explain the situation
 * and provide actionable next steps when available.
 */

import {
  Footprints,
  Trophy,
  Wallet,
  Bell,
  Search,
  Users,
  Calendar,
  FileText,
  Award,
  MessageSquare,
  Clock,
  LucideIcon,
} from 'lucide-react';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

// Base empty state component
export function EmptyState({
  icon: Icon = FileText,
  title,
  description,
  action,
  className = ''
}: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center py-10 px-6 text-center ${className}`}>
      <div className="w-14 h-14 rounded-2xl bg-brand-soft text-brand flex items-center justify-center mb-4" aria-hidden>
        <Icon size={26} strokeWidth={1.75} />
      </div>
      <h3 className="text-headline text-text-primary mb-1.5">{title}</h3>
      {description && (
        <p className="text-callout text-text-secondary max-w-[280px] mb-5">{description}</p>
      )}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="btn-primary h-11 px-5 rounded-control text-callout"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

// Pre-built contextual empty states

export function EmptySteps({
  onSync,
  className = ''
}: {
  onSync?: () => void;
  className?: string;
}) {
  return (
    <EmptyState
      icon={Footprints}
      title="No steps recorded today"
      description="Start walking to track your activity. Steps sync automatically from your device."
      action={onSync ? { label: 'Sync Now', onClick: onSync } : undefined}
      className={className}
    />
  );
}

export function EmptyChallenges({
  onBrowse,
  className = ''
}: {
  onBrowse?: () => void;
  className?: string;
}) {
  return (
    <EmptyState
      icon={Trophy}
      title="No active challenges"
      description="Join a challenge to compete with others and win rewards based on your steps."
      action={onBrowse ? { label: 'Browse Challenges', onClick: onBrowse } : undefined}
      className={className}
    />
  );
}

export function EmptyTransactions({ className = '' }: { className?: string }) {
  return (
    <EmptyState
      icon={Wallet}
      title="No transactions yet"
      description="Your wallet activity will appear here once you make deposits, withdrawals, or earn rewards."
      className={className}
    />
  );
}

export function EmptyWithdrawals({ className = '' }: { className?: string }) {
  return (
    <EmptyState
      icon={Wallet}
      title="No withdrawal history"
      description="Withdrawal requests will appear here after you request to withdraw funds."
      className={className}
    />
  );
}

export function EmptyNotifications({ className = '' }: { className?: string }) {
  return (
    <EmptyState
      icon={Bell}
      title="All caught up"
      description="You have no new notifications. We'll let you know when something important happens."
      className={className}
    />
  );
}

export function EmptySearchResults({
  query,
  onClear,
  className = ''
}: {
  query?: string;
  onClear?: () => void;
  className?: string;
}) {
  return (
    <EmptyState
      icon={Search}
      title="No results found"
      description={query ? `We couldn't find anything matching "${query}". Try a different search.` : 'Try adjusting your search or filters.'}
      action={onClear ? { label: 'Clear Search', onClick: onClear } : undefined}
      className={className}
    />
  );
}

export function EmptyParticipants({ className = '' }: { className?: string }) {
  return (
    <EmptyState
      icon={Users}
      title="No participants yet"
      description="Be the first to join this challenge!"
      className={className}
    />
  );
}

export function EmptyLeaderboard({ className = '' }: { className?: string }) {
  return (
    <EmptyState
      icon={Award}
      title="Leaderboard is empty"
      description="Rankings will appear once participants start recording steps."
      className={className}
    />
  );
}

export function EmptyHistory({ className = '' }: { className?: string }) {
  return (
    <EmptyState
      icon={Calendar}
      title="No activity history"
      description="Your step history will appear here as you track your daily activity."
      className={className}
    />
  );
}

export function EmptyBadges({
  onExplore,
  className = ''
}: {
  onExplore?: () => void;
  className?: string;
}) {
  return (
    <EmptyState
      icon={Award}
      title="No badges earned yet"
      description="Complete challenges and milestones to earn badges and build your collection."
      action={onExplore ? { label: 'See Available Badges', onClick: onExplore } : undefined}
      className={className}
    />
  );
}

export function EmptyMessages({ className = '' }: { className?: string }) {
  return (
    <EmptyState
      icon={MessageSquare}
      title="No messages"
      description="Challenge chat messages will appear here."
      className={className}
    />
  );
}

// Generic "coming soon" state
export function ComingSoon({
  feature = 'This feature',
  className = ''
}: {
  feature?: string;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center py-12 px-6 text-center ${className}`}>
      <div className="w-14 h-14 rounded-2xl bg-bg-input text-text-secondary flex items-center justify-center mb-4" aria-hidden>
        <Clock size={26} strokeWidth={1.75} />
      </div>
      <h3 className="text-headline text-text-primary mb-1.5">Coming soon</h3>
      <p className="text-callout text-text-secondary max-w-[280px]">
        {feature} is under development and will be available soon.
      </p>
    </div>
  );
}

// Compact inline empty state
export function EmptyInline({
  text,
  className = ''
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={`py-8 text-center text-text-muted text-sm ${className}`}>
      {text}
    </div>
  );
}
