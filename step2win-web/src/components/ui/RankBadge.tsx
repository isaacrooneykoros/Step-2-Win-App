import { Footprints, Gem, Medal, type LucideIcon } from 'lucide-react';
import { Pill, type Tone } from './Pill';

interface RankInfo {
  name: string;
  tone: Tone;
  icon: LucideIcon;
}

/** XP → rank tier. Tones stay semantic (no bespoke medal colours) and every tier carries its name. */
export function getRank(xp: number): RankInfo {
  if (xp >= 10000) return { name: 'Diamond', tone: 'info', icon: Gem };
  if (xp >= 5000) return { name: 'Platinum', tone: 'info', icon: Medal };
  if (xp >= 2000) return { name: 'Gold', tone: 'reward', icon: Medal };
  if (xp >= 800) return { name: 'Silver', tone: 'neutral', icon: Medal };
  if (xp >= 200) return { name: 'Bronze', tone: 'warning', icon: Medal };
  return { name: 'Rookie', tone: 'neutral', icon: Footprints };
}

interface RankBadgeProps {
  xp: number;
  className?: string;
}

export function RankBadge({ xp, className = '' }: RankBadgeProps) {
  const rank = getRank(xp);
  return (
    <Pill tone={rank.tone} icon={rank.icon} size="md" className={className}>
      {rank.name}
    </Pill>
  );
}

export default RankBadge;
