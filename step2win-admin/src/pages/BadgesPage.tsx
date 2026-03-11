import { useEffect, useState } from 'react';
import { Award, Users, Trophy, Zap, Target, Calendar } from 'lucide-react';
import { adminApi } from '../services/adminApi';
import type { AdminBadge } from '../types/admin';

export function BadgesPage() {
  const [badges, setBadges] = useState<AdminBadge[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi
      .getBadges()
      .then(setBadges)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const getBadgeTypeIcon = (type: string) => {
    switch (type) {
      case 'milestone':
        return <Target size={16} style={{ color: '#7C6FF7' }} />;
      case 'achievement':
        return <Trophy size={16} style={{ color: '#F5A623' }} />;
      case 'challenge':
        return <Zap size={16} style={{ color: '#4F9CF9' }} />;
      case 'streak':
        return <Calendar size={16} style={{ color: '#F5A623' }} />;
      case 'rank':
        return <Award size={16} style={{ color: '#22D3A0' }} />;
      default:
        return <Award size={16} className="text-ink-muted" />;
    }
  };

  const getBadgeTypeColor = (type: string) => {
    switch (type) {
      case 'milestone':
        return 'bg-[#7C6FF7]/10 text-[#7C6FF7]';
      case 'achievement':
        return 'bg-warn/10 text-warn';
      case 'challenge':
        return 'bg-info/10 text-info';
      case 'streak':
        return 'bg-warn/10 text-warn';
      case 'rank':
        return 'bg-up/10 text-up';
      default:
        return 'bg-surface-input text-ink-muted';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-ink-secondary">Loading badges...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-down/10 border border-down/20 text-down px-4 py-3 rounded-xl">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div
        className="rounded-2xl p-8"
        style={{
          background: 'linear-gradient(135deg, #7C6FF7 0%, #4F9CF9 100%)',
          boxShadow: '0 8px 32px rgba(79,156,249,0.25)',
        }}
      >
        <div className="flex items-center gap-3 mb-2">
          <div className="w-12 h-12 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center">
            <Award size={24} className="text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-white">Badge System</h1>
            <p className="text-white/80 text-sm">Manage achievement badges and rewards</p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 mt-6">
          <div className="bg-white/10 backdrop-blur-sm rounded-xl p-4">
            <div className="text-white/70 text-sm mb-1">Total Badges</div>
            <div className="text-white text-2xl font-bold">{badges.length}</div>
          </div>
          <div className="bg-white/10 backdrop-blur-sm rounded-xl p-4">
            <div className="text-white/70 text-sm mb-1">Total Awarded</div>
            <div className="text-white text-2xl font-bold">
              {badges.reduce((sum, b) => sum + b.users_earned, 0)}
            </div>
          </div>
          <div className="bg-white/10 backdrop-blur-sm rounded-xl p-4">
            <div className="text-white/70 text-sm mb-1">Most Popular</div>
            <div className="text-white text-xl font-bold">
              {badges.length > 0
                ? badges.reduce((prev, curr) =>
                    curr.users_earned > prev.users_earned ? curr : prev
                  ).icon
                : '—'}
            </div>
          </div>
        </div>
      </div>

      {/* Badges Grid */}
      {badges.length === 0 ? (
        <div className="bg-surface-card border border-surface-border rounded-2xl p-12 text-center">
          <Award size={48} className="text-ink-muted mx-auto mb-4" />
          <h3 className="text-ink-primary text-xl font-semibold mb-2">No Badges Yet</h3>
          <p className="text-ink-secondary">
            Run <code className="bg-surface-input px-2 py-1 rounded">python manage.py populate_badges</code> to create initial badges
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {badges.map((badge) => (
            <div
              key={badge.id}
              className="bg-surface-card border border-surface-border rounded-2xl p-6 hover:border-info/30 transition-all duration-200"
              style={{
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
              }}
            >
              {/* Badge Icon */}
              <div className="flex items-start gap-4 mb-4">
                <div
                  className="w-16 h-16 rounded-xl flex items-center justify-center text-3xl flex-shrink-0"
                  style={{
                    backgroundColor: badge.color + '20',
                    border: `2px solid ${badge.color}40`,
                  }}
                >
                  {badge.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-ink-primary font-bold text-lg mb-1 truncate">
                    {badge.name}
                  </h3>
                  <div className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium ${getBadgeTypeColor(badge.badge_type)}`}>
                    {getBadgeTypeIcon(badge.badge_type)}
                    {badge.badge_type}
                  </div>
                </div>
              </div>

              {/* Badge Description */}
              <p className="text-ink-secondary text-sm mb-4 line-clamp-2">
                {badge.description}
              </p>

              {/* Badge Stats */}
              <div className="flex items-center justify-between pt-4 border-t border-surface-border">
                <div className="flex items-center gap-2 text-ink-secondary text-sm">
                  <Users size={16} />
                  <span>Earned by</span>
                </div>
                <div className="text-ink-primary font-bold text-lg">
                  {badge.users_earned}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
