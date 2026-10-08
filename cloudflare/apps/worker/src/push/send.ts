// Delivers notices through Expo's push service, which hands them to Firebase (Android) and APNs
// (iOS). https://docs.expo.dev/push-notifications/sending-notifications/
//
// Each message is titled with the match, by its teams as the mobile lobby shows them, from the
// recipient's side ("You & Sam vs Alex & Jo"); its body says what happened, with the score in marks
// the same way round. Matches have no name of their own, and a game's name ("Game 3") is only the
// hand number within one.
//
// Best effort: a notice that can't be sent is logged and dropped - the match itself is already
// saved and broadcast. So is a failed name lookup: a player it couldn't name is called by their
// seat, as the apps do. Tokens Expo reports as no longer registered are forgotten. Push receipts
// (the later word on whether Firebase or APNs accepted a message) aren't checked.
import { Teams, botDisplayName, isBot, teamForPosition } from '@fortytwo/rules';
import type { Env } from '../index';
import { publicUsers } from '../users/publicUsers';
import type { Notice, NoticeKind } from './notices';
import { forgetTokens, tokensFor } from './tokens';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
// The Android notification channel the app creates (apps/mobile/src/notifications).
export const ANDROID_CHANNEL_ID = 'game';
const MAX_MESSAGES_PER_REQUEST = 100;

const HOUR = 60 * 60;
// How long Expo, Firebase and APNs keep trying a phone that's offline before dropping the notice.
// Without a ttl they keep it for up to a month, and a turn that has long since moved on - or a match
// expired after 14 idle days (expiry.ts) - shouldn't turn up when the phone comes back. A turn
// (or a poke about it) and a hand to ready up for are still worth hearing about the same day; the
// end of a match stays news a while longer, and nothing follows it to say so. The game on is
// followed straight away by a turn notice for the first bidder, so it's soon stale.
const TTL_SECONDS: Record<NoticeKind, number> = {
  turn: 12 * HOUR,
  poke: 12 * HOUR,
  handOver: 12 * HOUR,
  matchOver: 24 * HOUR,
  started: 1 * HOUR,
};

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
  ttl: number;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

// What `playerId` is called in a notice to its recipient.
function nameIn(notice: Notice, playerId: string, names: ReadonlyMap<string, string>): string {
  if (playerId === notice.playerId) return 'You';
  const name = names.get(playerId);
  if (name != null) return name;
  if (isBot(playerId)) return botDisplayName(playerId);
  const seat = notice.players.find((p) => p.playerId === playerId);
  return seat ? `Player ${seat.position + 1}` : 'A player';
}

// The recipient's team first, with them first in it; then the other team, both in seat order.
function matchTitle(notice: Notice, names: ReadonlyMap<string, string>): string {
  const seats = [...notice.players].sort((a, b) => a.position - b.position);
  const ownTeam = myTeam(notice);
  const team = (t: Teams) =>
    seats
      .filter((p) => teamForPosition(p.position) === t)
      .sort((a, b) => Number(b.playerId === notice.playerId) - Number(a.playerId === notice.playerId))
      .map((p) => nameIn(notice, p.playerId, names))
      .join(' & ') || 'Open seats';
  return `${team(ownTeam)} vs ${team(otherTeam(ownTeam))}`;
}

// "Hand over · Us 5, Them 3. Ready up for the next hand."
function noticeBody(notice: Notice): string {
  const ownTeam = myTeam(notice);
  const score = notice.marks && `Us ${notice.marks[ownTeam]}, Them ${notice.marks[otherTeam(ownTeam)]}`;
  const rest = [score, notice.detail].filter((part) => part != null).join('. ');
  return rest ? `${notice.headline} · ${rest}` : notice.headline;
}

function myTeam(notice: Notice): Teams {
  const seat = notice.players.find((p) => p.playerId === notice.playerId);
  return seat ? teamForPosition(seat.position) : Teams.TeamA;
}

function otherTeam(team: Teams): Teams {
  return team === Teams.TeamA ? Teams.TeamB : Teams.TeamA;
}

// `names` maps player ids to display names; anyone missing from it is called by their seat.
export function messagesFor(
  notices: Notice[],
  tokens: { token: string; userId: string }[],
  names: ReadonlyMap<string, string> = new Map()
): ExpoMessage[] {
  return notices.flatMap((notice) =>
    tokens
      .filter((t) => t.userId === notice.playerId)
      .map((t) => ({
        to: t.token,
        title: matchTitle(notice, names),
        body: noticeBody(notice),
        data: { url: `/match/${notice.matchId}` },
        sound: 'default' as const,
        // Both say it's the player's turn.
        priority: notice.kind === 'turn' || notice.kind === 'poke' ? ('high' as const) : ('default' as const),
        channelId: ANDROID_CHANNEL_ID,
        collapseId: `match-${notice.matchId}`,
        tag: `match-${notice.matchId}`,
        ttl: TTL_SECONDS[notice.kind],
      }))
  );
}

export async function sendNotices(env: Env, notices: Notice[]): Promise<void> {
  if (notices.length === 0) return;
  try {
    const tokens = await tokensFor(env.DB, [...new Set(notices.map((n) => n.playerId))]);
    // Nobody has a device to send to, so there is no one to look up.
    if (tokens.length === 0) return;
    const names = await playerNames(env, notices);
    const messages = messagesFor(notices, tokens, names);
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

// Everyone at the tables the notices are about, in one lookup. A lookup that fails sends the notices
// anyway, with players called by their seat.
async function playerNames(env: Env, notices: Notice[]): Promise<Map<string, string>> {
  const ids = [...new Set(notices.flatMap((n) => n.players.map((p) => p.playerId)))];
  try {
    const { users } = await publicUsers(env, ids);
    return new Map(users.map((u) => [u.user_id, u.displayName]));
  } catch (err) {
    console.error('Looking up player names for push notifications failed', err);
    return new Map();
  }
}
