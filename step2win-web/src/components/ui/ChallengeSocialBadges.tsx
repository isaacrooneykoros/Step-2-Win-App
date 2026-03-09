import { useQuery } from '@tanstack/react-query';
import { Trophy, TrendingUp, Flame } from 'lucide-react';
import { challengesService } from '../../services/api';

interface ChallengeSocialBadgesProps {
  challengeId: number;
}

export function ChallengeSocialBadges({ challengeId }: ChallengeSocialBadgesProps) {
  const { data: stats, isLoading } = useQuery({
    queryKey: ['challenges', challengeId, 'social-stats'],
    queryFn: () => challengesService.getSocialStats(challengeId),
    retry: 1,
  });

  if (isLoading) {
    return (
      <div className="card rounded-4xl p-5">
        <div className="text-center text-text-muted text-sm">Loading achievements...</div>
      </div>
    );
  }

  if (!stats) return null;

  const formatBadgeValue = (key: string, value: any) => {
    if (!value) return null;
    
    if (key === 'most_consistent') {
      return `${value.username} - ${value.days_active} active days`;
    }
    if (key === 'biggest_single_day') {
      return `${value.username} - ${value.steps.toLocaleString()} steps`;
    }
    if (key === 'most_improved') {
      return `${value.username} - ${value.improvement_percent}% improvement`;
    }
    return null;
  };

  const badges = [
    {
      key: 'most_consistent',
      icon: Flame,
      color: 'text-orange-500',
      bgColor: 'bg-orange-500/10',
      label: '🔥 Most Consistent',
      value: stats.most_consistent,
    },
    {
      key: 'biggest_single_day',
      icon: Trophy,
      color: 'text-yellow-500',
      bgColor: 'bg-yellow-500/10',
      label: '👑 Biggest Single Day',
      value: stats.biggest_single_day,
    },
    {
      key: 'most_improved',
      icon: TrendingUp,
      color: 'text-green-500',
      bgColor: 'bg-green-500/10',
      label: '📈 Most Improved',
      value: stats.most_improved,
    },
  ].filter((badge) => badge.value);

  if (badges.length === 0) {
    return null;
  }

  return (
    <div className="card rounded-4xl p-5">
      <h3 className="text-lg font-black text-text-primary mb-4">
        🏆 Social Achievements
      </h3>
      <div className="space-y-3">
        {badges.map((badge) => {
          const Icon = badge.icon;
          const displayValue = formatBadgeValue(badge.key, badge.value);
          
          if (!displayValue) return null;
          
          return (
            <div
              key={badge.key}
              className={`flex items-center gap-3 p-3 rounded-2xl ${badge.bgColor}`}
            >
              <div className={`${badge.color}`}>
                <Icon size={24} strokeWidth={2.5} />
              </div>
              <div className="flex-1">
                <div className="font-bold text-sm text-text-primary">
                  {badge.label}
                </div>
                <div className="text-text-secondary text-sm">
                  {displayValue}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
