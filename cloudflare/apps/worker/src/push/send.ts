// Delivers notices through Expo's push service, which hands them to Firebase (Android) and APNs
// (iOS). https://docs.expo.dev/push-notifications/sending-notifications/
//
// Best effort: a notice that can't be sent is logged and dropped - the match itself is already
// saved and broadcast. Tokens Expo reports as no longer registered are forgotten. Push receipts
// (the later word on whether Firebase or APNs accepted a message) aren't checked.
import type { Env } from '../index';
import type { Notice } from './notices';
import { forgetTokens, tokensFor } from './tokens';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
// The Android notification channel the app creates (apps/mobile/src/notifications).
export const ANDROID_CHANNEL_ID = 'game';
const MAX_MESSAGES_PER_REQUEST = 100;

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: { url: string };
  sound: 'default';
  priority: 'high' | 'default';
  channelId: string;
  // A newer notice for the same match replaces an older one, rather than piling up.
  collapseId: string;
  tag: string;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

export function messagesFor(notices: Notice[], tokens: { token: string; userId: string }[]): ExpoMessage[] {
  return notices.flatMap((notice) =>
    tokens
      .filter((t) => t.userId === notice.playerId)
      .map((t) => ({
        to: t.token,
        title: notice.title,
        body: notice.body,
        data: { url: `/match/${notice.matchId}` },
        sound: 'default' as const,
        priority: notice.kind === 'turn' ? ('high' as const) : ('default' as const),
        channelId: ANDROID_CHANNEL_ID,
        collapseId: `match-${notice.matchId}`,
        tag: `match-${notice.matchId}`,
      }))
  );
}

export async function sendNotices(env: Env, notices: Notice[]): Promise<void> {
  if (notices.length === 0) return;
  try {
    const tokens = await tokensFor(env.DB, [...new Set(notices.map((n) => n.playerId))]);
    const messages = messagesFor(notices, tokens);
    const unregistered: string[] = [];

    for (let i = 0; i < messages.length; i += MAX_MESSAGES_PER_REQUEST) {
      const batch = messages.slice(i, i + MAX_MESSAGES_PER_REQUEST);
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          // Only needed once "enhanced push security" is turned on for the Expo project.
          ...(env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
        },
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        console.error('Expo push request failed', res.status, await res.text());
        continue;
      }
      // Tickets come back in the order the messages were sent.
      const { data } = (await res.json()) as { data?: ExpoTicket[] };
      data?.forEach((ticket, j) => {
        if (ticket.status !== 'error') return;
        if (ticket.details?.error === 'DeviceNotRegistered') unregistered.push(batch[j].to);
        else console.error('Expo push ticket error', ticket.message, ticket.details);
      });
    }

    await forgetTokens(env.DB, unregistered);
  } catch (err) {
    console.error('Sending push notifications failed', err);
  }
}
