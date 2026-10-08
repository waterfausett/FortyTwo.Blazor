// Push notifications: the Worker sends one when it's the player's turn, a hand they're in ends, or
// a game of theirs starts - unless they have that match open (worker: push/notices.ts). This
// registers the device for them and opens the match when one is tapped. A hand over carries a
// Ready up button and a match over a Rematch button, which open the match and do the same.
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

// The buttons on the Worker's hand over and match over notices (push/send.ts's CATEGORIES, by the
// same ids). Each opens the app, which then does what the match screen's button does: opening it
// lets the player see it happen, and a request sent from the background could go unanswered.
const READY_ACTION = 'ready';
const REMATCH_ACTION = 'rematch';
export async function registerCategories(): Promise<void> {
  await Notifications.setNotificationCategoryAsync('handOver', [
    { identifier: READY_ACTION, buttonTitle: 'Ready up', options: { opensAppToForeground: true } },
  ]);
  await Notifications.setNotificationCategoryAsync('matchOver', [
    { identifier: REMATCH_ACTION, buttonTitle: 'Rematch', options: { opensAppToForeground: true } },
  ]);
}
// Registered on launch, before any notification can arrive. A notice that comes before they are
// (or on a device where this failed) shows without its button, and a tap still opens the match.
void registerCategories().catch(() => {});

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

// The device's own token (FCM's on Android, APNs' on iOS), as last seen. On Android every
// getDevicePushTokenAsync also fires the push-token listeners with the token it got - so a listener
// that registered again on every event would set off another, and another, without end: a
// constant stream of native calls and requests that held up everything else. A token is only new
// if it differs from this.
let lastDeviceToken: string | null = null;

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
  // Passed on, so Expo doesn't ask the OS for it a second time.
  const device = await Notifications.getDevicePushTokenAsync();
  lastDeviceToken = String(device.data);
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId, devicePushToken: device });
  return data;
}

// Calls `onChange` when the OS hands the device a new token - not for the same token again, which
// Android reports each time it's fetched (above). One seen before any was fetched is taken as the
// first rather than a change: it comes from a fetch under way, which registers it.
export function addPushTokenChangeListener(onChange: () => void): { remove(): void } {
  return Notifications.addPushTokenListener((token) => {
    const data = String(token.data);
    if (data === lastDeviceToken) return;
    const changed = lastDeviceToken != null;
    lastDeviceToken = data;
    if (changed) onChange();
  });
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

// Whether a tap is new: the same tap can reach the app twice. On a launch from a notification,
// Android both keeps it as the last response and replays it as an event once the module starts -
// which can land after the listener is added - so opening on each would stack the match twice.
let lastTap: string | null = null;
export function isNewTap(response: Notifications.NotificationResponse): boolean {
  const tap = `${response.notification.request.identifier}:${response.actionIdentifier}`;
  if (tap === lastTap) return false;
  lastTap = tap;
  return true;
}

// The app route a tapped notification opens (the Worker puts it in `data.url`).
export function notificationRoute(notification: Notifications.Notification): string | null {
  const url = notification.request.content.data?.url;
  return typeof url === 'string' && url.startsWith('/') ? url : null;
}

// Does what a notice's button asks, for the match the notice is about: readies up, or asks for a
// rematch. Returns whether there was anything to do - not for a plain tap. The match screen, which
// the button also opens, shows how it went.
export async function takeNotificationAction(api: Api, response: Notifications.NotificationResponse): Promise<boolean> {
  const matchId = notificationRoute(response.notification)?.match(/^\/match\/([^/?#]+)$/)?.[1];
  if (matchId == null) return false;
  if (response.actionIdentifier === READY_ACTION) await api.readyUp(matchId, true);
  else if (response.actionIdentifier === REMATCH_ACTION) await api.rematch(matchId);
  else return false;
  return true;
}
