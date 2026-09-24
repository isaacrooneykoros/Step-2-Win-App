import { listOutboxItems, removeOutboxItem } from '../services/offlineSyncOutbox';
import { syncReminderNotifications } from '../services/notifications';

/**
 * Removes everything this device keeps for one account (after the account is deleted):
 * queued step uploads, per-user ledgers / flags, stray tokens and scheduled reminders.
 * Auth tokens and the biometric lock are cleared by `useAuthStore.logout()` (the lock
 * turns itself off on logout, see lib/biometricLock). Best effort: never throws.
 */
export async function clearLocalUserData(userId?: number | null) {
  if (userId) {
    try {
      const items = await listOutboxItems(userId);
      await Promise.all(items.map((item) => removeOutboxItem(item.queueKey)));
    } catch {
      // Outbox unavailable: nothing to clear.
    }
  }

  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !userId) continue;
      if (key === `hourly_step_ledger_v1:${userId}` || key.startsWith(`celebration_shown_${userId}_`)) doomed.push(key);
    }
    doomed.forEach((key) => localStorage.removeItem(key));
    sessionStorage.removeItem('access_token');
    sessionStorage.removeItem('refresh_token');
  } catch {
    // Storage unavailable.
  }

  try {
    await syncReminderNotifications({ pushNotifications: false, challengeReminders: false, payoutAlerts: false });
  } catch {
    // Web / no permission: nothing scheduled.
  }
}
