// Keeps this device's push registration in step with the signed-in player (src/notifications/
// push.ts), and opens the match a tapped notification is about.
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useApi } from '@/api/useApi';
import { useProfile } from '@/api/useProfile';
import { noteIncomingLink } from '@/linking/incomingLink';
import { addPushTokenChangeListener, isNewTap, notificationRoute, registerDevice, unregisterDevice } from './push';

export function usePushNotifications(signedIn: boolean): void {
  const api = useApi();
  const profile = useProfile({ enabled: signedIn });
  const enabled = signedIn ? profile.data?.pushNotifications : undefined;

  // On each launch (and whenever the setting changes), register or unregister this device to
  // match the player's setting - without asking for permission; that waits for a match. Expo can
  // also hand the device a new token, which is registered in place of the old.
  useEffect(() => {
    if (enabled === undefined) return;
    const sync = () => (enabled ? registerDevice(api, { ask: false }) : unregisterDevice(api)).catch(() => {});
    void sync();
    if (!enabled) return;
    const subscription = addPushTokenChangeListener(() => void sync());
    return () => subscription.remove();
  }, [api, enabled]);

  // A tapped notification opens its match - straight away when signed in, or after sign-in
  // (incomingLink.ts) otherwise. Covers one that launched the app as well as one tapped while
  // it's running - each tap once, however many ways it arrives (isNewTap).
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse) => {
      if (!isNewTap(response)) return;
      const route = notificationRoute(response.notification);
      if (route == null) return;
      if (signedIn) router.push(route);
      else noteIncomingLink(route);
    };
    const launchedBy = Notifications.getLastNotificationResponse();
    if (launchedBy) {
      open(launchedBy);
      Notifications.clearLastNotificationResponse();
    }
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [signedIn]);
}
