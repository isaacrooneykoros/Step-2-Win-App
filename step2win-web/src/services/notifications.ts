import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

export type NotificationPreferences = {
  pushNotifications: boolean;
  challengeReminders: boolean;
  payoutAlerts: boolean;
};

const CHANNEL_ID = 'step2win_reminders';
const CHALLENGE_NOTIFICATION_ID = 3001;
const PAYOUT_NOTIFICATION_ID = 3002;

async function ensureAndroidChannel() {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    return;
  }

  await LocalNotifications.createChannel({
    id: CHANNEL_ID,
    name: 'Step2Win reminders',
    description: 'Challenge and wallet reminders from Step2Win',
    importance: 4,
    visibility: 1,
    lights: true,
    vibration: true,
    lightColor: '#4F9CF9',
  });
}

export async function checkNotificationPermission() {
  if (!Capacitor.isNativePlatform()) {
    return 'granted' as const;
  }

  const status = await LocalNotifications.checkPermissions();
  return status.display;
}

export async function requestNotificationPermission() {
  if (!Capacitor.isNativePlatform()) {
    return true;
  }

  const status = await LocalNotifications.requestPermissions();
  return status.display === 'granted';
}

export async function syncReminderNotifications(preferences: NotificationPreferences) {
  if (!Capacitor.isNativePlatform()) {
    return;
  }

  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== 'granted' || !preferences.pushNotifications) {
    await LocalNotifications.cancel({
      notifications: [
        { id: CHALLENGE_NOTIFICATION_ID },
        { id: PAYOUT_NOTIFICATION_ID },
      ],
    });
    return;
  }

  await ensureAndroidChannel();
  await LocalNotifications.cancel({
    notifications: [
      { id: CHALLENGE_NOTIFICATION_ID },
      { id: PAYOUT_NOTIFICATION_ID },
    ],
  });

  const notifications = [] as Array<Parameters<typeof LocalNotifications.schedule>[0]['notifications'][number]>;

  if (preferences.challengeReminders) {
    notifications.push({
      id: CHALLENGE_NOTIFICATION_ID,
      title: 'Challenge reminder',
      body: 'Open Step2Win and keep your challenge momentum going.',
      channelId: CHANNEL_ID,
      schedule: {
        on: {
          hour: 19,
          minute: 0,
        },
      },
      extra: { type: 'challenge-reminder' },
      smallIcon: 'ic_launcher',
      autoCancel: true,
    });
  }

  if (preferences.payoutAlerts) {
    notifications.push({
      id: PAYOUT_NOTIFICATION_ID,
      title: 'Wallet and payout check-in',
      body: 'Review your wallet and reward updates inside Step2Win.',
      channelId: CHANNEL_ID,
      schedule: {
        on: {
          hour: 20,
          minute: 0,
        },
      },
      extra: { type: 'payout-alert' },
      smallIcon: 'ic_launcher',
      autoCancel: true,
    });
  }

  if (notifications.length > 0) {
    await LocalNotifications.schedule({ notifications });
  }
}

export async function openNotificationSettings() {
  if (!Capacitor.isNativePlatform()) {
    return;
  }
}
