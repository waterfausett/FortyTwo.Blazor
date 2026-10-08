// Keeps this device's push registration in step with the signed-in player (src/notifications/
// push.ts), and opens the match a tapped notification is about - taking the action too, when it was
// one of its buttons.
import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { type Href, router, usePathname } from 'expo-router';
import { useApi } from '@/api/useApi';
import { useProfile } from '@/api/useProfile';
import { noteIncomingLink } from '@/linking/incomingLink';
import {
  addPushTokenChangeListener,
  isNewTap,
  notificationRoute,
  registerDevice,
  takeNotificationAction,
  unregisterDevice,
} from './push';

export function usePushNotifications(signedIn: boolean): void {
  const api = useApi();
  const profile = useProfile({ enabled: signedIn });
  const enabled = signedIn ? profile.data?.pushNotifications : undefined;
  // Read when a notification is tapped, without setting up the listener again on each navigation.
  const pathname = useRef('');
  pathname.current = usePathname();

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
  // it's running - each tap once, however many ways it arrives (isNewTap). From a match, the
  // tapped one takes its place rather than stacking on it, as a rematch does: left underneath, a
  // finished match would follow its rematch as soon as Back showed it (match/[id].tsx), opening
  // the tapped match a second time. One already on screen isn't opened again - the Worker skips
  // a match that's open, but one left open in the background has no socket, so gets notified.
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse) => {
      if (!isNewTap(response)) return;
      const route = notificationRoute(response.notification);
      if (route == null) return;
      if (!signedIn) {
        // Signing in comes first; the button's action is left to the player, on the match.
        noteIncomingLink(route);
        return;
      }
      if (route !== pathname.current) {
        if (pathname.current.startsWith('/match/')) router.replace(route as Href);
        else router.push(route as Href);
      }
      // A button's notification stays in the shade on Android once pressed; it's done with.
      void takeNotificationAction(api, response)
        .then((took) => {
          if (took) return Notifications.dismissNotificationAsync(response.notification.request.identifier);
        })
        .catch(() => {});
    };
    const launchedBy = Notifications.getLastNotificationResponse();
    if (launchedBy) {
      open(launchedBy);
      Notifications.clearLastNotificationResponse();
    }
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [api, signedIn]);
}
