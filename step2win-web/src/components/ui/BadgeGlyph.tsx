import { Award, CalendarCheck, Flame, Footprints, Medal, Trophy, type LucideIcon } from 'lucide-react';
import type { Badge } from '../../services/api/gamification';

/**
 * Badges store an emoji in `badge.icon` on the backend. The UI never renders it;
 * the badge type (and slug hints) select a Lucide icon so the icon language stays coherent.
 */
export function badgeIcon(badge: Pick<Badge, 'badge_type' | 'slug'>): LucideIcon {
  const slug = badge.slug?.toLowerCase() ?? '';
  if (slug.includes('streak') || slug.includes('consisten')) return Flame;
  if (slug.includes('login') || slug.includes('daily')) return CalendarCheck;
  switch (badge.badge_type) {
    case 'streak':
      return Flame;
    case 'step':
      return Footprints;
    case 'challenge':
      return Trophy;
    case 'achievement':
      return Medal;
    default:
      return Award;
  }
}

interface BadgeGlyphProps {
  badge: Pick<Badge, 'badge_type' | 'slug' | 'name'>;
  size?: 'sm' | 'md' | 'lg';
  /** Locked badges render muted. */
  locked?: boolean;
  className?: string;
}

const dims = {
  sm: { box: 'h-10 w-10 rounded-xl', icon: 18 },
  md: { box: 'h-12 w-12 rounded-2xl', icon: 22 },
  lg: { box: 'h-16 w-16 rounded-[20px]', icon: 28 },
};

export function BadgeGlyph({ badge, size = 'md', locked = false, className = '' }: BadgeGlyphProps) {
  const Icon = badgeIcon(badge);
  const d = dims[size];
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${d.box} ${
        locked ? 'bg-bg-input text-text-muted' : 'bg-reward-soft text-reward-ink'
      } ${className}`}
      aria-hidden
    >
      <Icon size={d.icon} strokeWidth={1.9} />
    </span>
  );
}

export default BadgeGlyph;
