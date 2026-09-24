import { api } from '../../services/api';
import type { UserBadge } from '../../services/api/gamification';

/**
 * `/badges/my_badges/` returns a bare array, while gamificationService.getMyBadges
 * only reads `.results` (so it always yields []). Accept both shapes here.
 */
export async function fetchMyBadges(): Promise<UserBadge[]> {
  const response = await api.get<UserBadge[] | { results?: UserBadge[] }>('/api/gamification/badges/my_badges/');
  const data = response.data;
  return Array.isArray(data) ? data : data?.results ?? [];
}
