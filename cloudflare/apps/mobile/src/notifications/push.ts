// Push notifications: the Worker sends one when it's the player's turn, a hand they're in ends, or
// a game of theirs starts - unless they have that match open (worker: push/notices.ts). This
// registers the device for them and opens the match when one is tapped.
//
// A device is registered only once the player has given the OS permission and has notifications
// on in their profile (on unless turned off). Permission is asked for when they first sit at a
// match, not at launch, so the prompt comes when its point is clear.
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { Api } from '@/api/useApi';

// Must match the channel the Worker sends to (push/send.ts's ANDROID_CHANNEL_ID).
export const CHANNEL_ID = 'game';

// A notification for some other match than the one on screen still shows while the app is open;
// the Worker sends none for a match that's open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// Android sends notifications through a channel, which must exist before a token is asked for
// (and before Android 13+ will show the permission prompt).
async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Game updates',
    description: 'Your turn, the end of a hand, and games starting',
    importance: Notifications.AndroidImportance.HIGH,
  });
}

// The token that identifies this device to Expo's push service, or null without permission.
// `ask` shows the OS prompt if the player hasn't been asked yet.
export async function devicePushToken({ ask }: { ask: boolean }): Promise<string | null> {
  await ensureChannel();
  let { status, canAskAgain } = await Notifications.getPermissionsAsync();
  if (status !== 'granted' && ask && canAskAgain) {
    ({ status } = await Notifications.requestPermissionsAsync());
  }
  if (status !== 'granted') return null;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return data;
}

function platform(): 'android' | 'ios' {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

// Registers this device for the signed-in player, if notifications are allowed. Returns whether
// it's registered.
export async function registerDevice(api: Api, { ask }: { ask: boolean }): Promise<boolean> {
  const token = await devicePushToken({ ask });
  if (token == null) return false;
  await api.registerPushToken(token, platform());
  return true;
}

// Stops this device getting the signed-in player's notifications: on sign-out, or when they turn
// notifications off. Without permission there's no token, so nothing was registered.
export async function unregisterDevice(api: Api): Promise<void> {
  const token = await devicePushToken({ ask: false });
  if (token != null) await api.removePushToken(token);
}

// Asks for notification permission the first time the player sits at a match in this run of
// the app - when it's clear what notifications would be for - and registers the device if they
// allow it. Once they've answered, the OS remembers and doesn't ask again.
let askedThisRun = false;
export function askOnceForPush(api: Api): void {
  if (askedThisRun) return;
  askedThisRun = true;
  void registerDevice(api, { ask: true }).catch(() => {});
}

// The app route a tapped notification opens (the Worker puts it in `data.url`).
export function notificationRoute(notification: Notifications.Notification): string | null {
  const url = notification.request.content.data?.url;
  return typeof url === 'string' && url.startsWith('/') ? url : null;
}
