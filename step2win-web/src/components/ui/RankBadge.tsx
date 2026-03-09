import React from 'react';

interface RankInfo {
  name: string;
  color: string;
  emoji: string;
}

export function getRank(xp: number): RankInfo {
  if (xp >= 10000) return { name: 'Diamond', color: '#A78BFA', emoji: '💎' };
  if (xp >= 5000)  return { name: 'Platinum', color: '#4F9CF9', emoji: '🥇' };
  if (xp >= 2000)  return { name: 'Gold',     color: '#FBBF24', emoji: '🏅' };
  if (xp >= 800)   return { name: 'Silver',   color: '#9CA3AF', emoji: '🥈' };
  if (xp >= 200)   return { name: 'Bronze',   color: '#F87171', emoji: '🥉' };
  return                   { name: 'Rookie',  color: '#6B7280', emoji: '👟' };
}

interface RankBadgeProps {
  xp: number;
  className?: string;
}

export const RankBadge: React.FC<RankBadgeProps> = ({ xp, className = '' }) => {
  const rank = getRank(xp);
  
  return (
    <div 
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-bg-page ${className}`}
    >
      <span className="text-sm">{rank.emoji}</span>
      <span 
        className="text-xs font-bold"
        style={{ color: rank.color }}
      >
        {rank.name}
      </span>
    </div>
  );
};
