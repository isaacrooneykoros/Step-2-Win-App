import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { socialService, type SocialNotificationKind } from '../../services/api/social';
import { usePollInterval } from '../../hooks/useDataSaver';
import { loadPreferences } from '../settings/preferences';
import { SUMMARY_POLL_MS, socialKeys } from './socialUtils';

const SEEN_KEY = 'social_notification_seen_v1';
const NOTIFICATION_ID = 3101;

const TITLES: Record<SocialNotificationKind, string> = {
  friend_request: 'New friend request',
  friend_accepted: 'Friend request accepted',
  weekly_results: 'Your weekly results are in',
  reaction: 'Someone cheered you on',
  team_role: 'Team update',
  team_removed: 'Team update',
};

function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) || 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * Keeps the Friends inbox count fresh and, on the phone app, raises ONE local
 * notification when something new arrives (friend requests, accepts, weekly results).
 *
 * Low data: a tiny summary request every 10 minutes while the app is open, none with
 * Data Saver (then it refreshes on open / resume only). Respects the app's
 * "Push notifications" switch and the per-kind social switches (switched-off kinds
 * are never stored by the server).
 */
export function SocialNotifier() {
  const poll = usePollInterval(SUMMARY_POLL_MS);
  const { data } = useQuery({
    queryKey: socialKeys.summary,
    queryFn: socialService.notificationSummary,
    refetchInterval: poll,
    refetchOnWindowFocus: true,
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    const latest = data?.latest_id;
    if (!data?.enabled || !latest || !data.latest_kind) return;
    const seen = readSeen();
    if (latest <= seen) return;
    try {
      localStorage.setItem(SEEN_KEY, String(latest));
    } catch {
      // storage unavailable: at worst a notice repeats once
    }
    // First run on this device: remember the newest item without notifying about history.
    if (seen === 0) return;
    if (!Capacitor.isNativePlatform() || !loadPreferences().pushNotifications) return;
    const kind = data.latest_kind;
    void (async () => {
      try {
        const permission = await LocalNotifications.checkPermissions();
        if (permission.display !== 'granted') return;
        await LocalNotifications.schedule({
          notifications: [
            {
              id: NOTIFICATION_ID,
              title: TITLES[kind] ?? 'Step2Win',
              body: data.unread > 1 ? `You have ${data.unread} new updates in Friends.` : 'Open Friends to see it.',
              channelId: 'step2win_reminders',
              extra: { type: 'social', route: kind === 'friend_request' ? '/social?tab=friends' : '/social/inbox' },
              smallIcon: 'ic_stat_step2win',
              iconColor: '#14855D',
              autoCancel: true,
            },
          ],
        });
      } catch {
        // notifications are best effort
      }
    })();
  }, [data]);

  return null;
}

export default SocialNotifier;
