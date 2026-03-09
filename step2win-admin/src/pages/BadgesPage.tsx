import { useEffect, useState } from 'react';
import { adminApi } from '../services/adminApi';
import type { AdminBadge } from '../types/admin';

export function BadgesPage() {
  const [badges, setBadges] = useState<AdminBadge[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    adminApi.getBadges().then(setBadges).catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <p className="error">{error}</p>;

  return (
    <div className="badge-grid">
      {badges.map((badge) => (
        <article className="badge-card" key={badge.id} style={{ borderColor: badge.color }}>
          <div className="badge-head">
            <span className="badge-icon">{badge.icon}</span>
            <h3>{badge.name}</h3>
          </div>
          <p>{badge.description}</p>
          <div className="badge-meta">
            <span>Type: {badge.badge_type}</span>
            <span>Earned: {badge.users_earned}</span>
          </div>
        </article>
      ))}
    </div>
  );
}
