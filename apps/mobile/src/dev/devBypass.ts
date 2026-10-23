// A development-only way past sign-in, for working on screens in the emulator without an Auth0
// login or a Worker: with EXPO_PUBLIC_DEV_BYPASS=1, the app acts signed in and the API answers
// from the canned data below. scripts/emulator.ps1 turns it on.
//
// It can't reach a release build: `__DEV__` is false there, so this is always false and the
// bundler drops the code behind it.
//
// The lobby, the profile (stats included) work this way, and the canned matches in devMatches.ts (open
// `match/dev-bidding` and the rest). Anything else fails with "Not in the dev bypass".
import type { MatchState } from '@fortytwo/rules';
import type { Invite, Person } from '@fortytwo/client';
import type { MatchPage, MatchSummary, PlayerStats, ProfilePatch, UserProfile } from '@fortytwo/api-types';
import type { Api } from '@/api/useApi';
import { DEV_PLAYER_ID, devMatchApi } from './devMatches';

export const DEV_BYPASS = __DEV__ && process.env.EXPO_PUBLIC_DEV_BYPASS === '1';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

// A lobby row from who's in each seat (0-3, null for open). Teams are seats 0 & 2 and 1 & 3.
function summary(id: string, seats: (string | null)[], minutesAgo: number, status: MatchSummary['status'] = 'active'): MatchSummary {
  const named = (positions: number[]) => positions.map((p) => seats[p]).filter((s): s is string => s != null);
  return {
    id,
    status,
    playerCount: seats.filter((s) => s != null).length,
    updatedOn: ago(minutesAgo),
    seats,
    teams: [named([0, 2]), named([1, 3])],
    mode: 'custom',
  };
}

// Every state a row can be in: full, waiting on players, long names, each age of timestamp.
const LISTS: Record<'Active' | 'Joinable' | 'Completed', MatchSummary[]> = {
  Active: [
    summary('active-1', ['You', 'Grandma Jo', 'Uncle Ray', 'Beth'], 3),
    summary('active-2', ['You', null, 'Kendra', null], 45),
    summary('active-3', ['Marcus', 'You', 'Priscilla Vandermeer-Hughes', 'Tom'], 60 * 5),
    summary('active-4', ['You', null, null, null], 60 * 26),
    summary('active-5', ['Lou', 'Dee', 'You', 'Sam'], 60 * 24 * 4),
  ],
  // The lobby no longer lists open seats to join.
  Joinable: [],
  Completed: [
    summary('done-1', ['You', 'Grandma Jo', 'Uncle Ray', 'Beth'], 60 * 24 * 2, 'completed'),
    summary('done-2', ['Marcus', 'You', 'Kendra', 'Tom'], 60 * 24 * 9, 'completed'),
  ],
};

let profile: UserProfile = {
  user_id: DEV_PLAYER_ID,
  email: 'you@example.com',
  displayName: 'You',
  highlightPlayable: true,
  pushNotifications: false,
  // So the Lobby offers How to play on each launch, until dismissed.
  seenHowToPlay: false,
};

// A short wait, so loading states show.
const answer = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 300));

const handled: Partial<Api> = {
  listMatches: (filter) => answer<MatchPage>({ matches: LISTS[filter], nextCursor: null }),
  getProfile: () => answer({ ...profile }),
  patchProfile: async (patch: ProfilePatch) => {
    const { picture, ...rest } = patch;
    profile = { ...profile, ...rest, ...(picture !== undefined && { picture: picture || undefined }) };
    await answer(undefined);
  },
  getStats: () =>
    answer<PlayerStats>({
      all: { played: 23, won: 14, lost: 9, marksWon: 131, bidsWon: 41, bidsMade: 30, bidsSet: 11, averagePointsBid: 32.4, marksBids: 9, favoriteTrump: { trump: 'sixes', times: 12 }, bestPartner: { user: { user_id: 'gj', displayName: 'Grandma Jo' }, won: 7, lost: 2 } },
      humansOnly: { played: 15, won: 8, lost: 7, marksWon: 82, bidsWon: 26, bidsMade: 18, bidsSet: 8, averagePointsBid: 32.1, marksBids: 6, favoriteTrump: { trump: 'sixes', times: 8 }, bestPartner: { user: { user_id: 'gj', displayName: 'Grandma Jo' }, won: 7, lost: 2 } },
      withBots: { played: 8, won: 6, lost: 2, marksWon: 49, bidsWon: 15, bidsMade: 12, bidsSet: 3, averagePointsBid: 33.0, marksBids: 3, favoriteTrump: { trump: 'fives', times: 5 }, bestPartner: null },
    }),
  // Nothing to tell a server about this device.
  registerPushToken: () => answer(undefined),
  removePushToken: () => answer(undefined),
  deleteAccount: () => answer(undefined),
  // Creating or joining "works", landing on a match screen that can't load.
  createMatch: () => answer({ id: 'dev-new' } as MatchState),
  play: () => answer({ id: 'dev-new' } as MatchState),
  playBots: () => answer({ id: 'dev-new' } as MatchState),
  joinMatch: (id) => answer({ id } as MatchState),
  getPeople: (show) =>
    answer<Person[]>(
      [
        { user_id: 'gj', displayName: 'Grandma Jo', isFriend: true, lastPlayedOn: new Date(Date.now() - 2 * 86_400_000).toISOString(), games: 9 },
        { user_id: 'sam', displayName: 'Sam', isFriend: false, lastPlayedOn: new Date(Date.now() - 3 * 3_600_000).toISOString(), games: 1 },
      ].filter((p) => (show === 'friends' ? p.isFriend : show === 'recent' ? !p.isFriend : true))
    ),
  searchPeople: () => answer<Person[]>([]),
  addFriend: () => answer(undefined),
  removeFriend: () => answer(undefined),
  getInvites: () =>
    answer<Invite[]>([{ matchId: 'dev-new', from: { user_id: 'gj', displayName: 'Grandma Jo' }, createdOn: new Date().toISOString(), seatsOpen: 2 }]),
  dismissInvite: () => answer(undefined),
  invitePlayers: (_matchId, userIds) => answer({ invited: userIds }),
  ...devMatchApi,
};

export const devApi = new Proxy(handled, {
  get: (target, name) => {
    // Not a promise, whatever awaits it.
    if (typeof name !== 'string' || name === 'then') return undefined;
    return target[name as keyof Api] ?? (() => Promise.reject(new Error(`Not in the dev bypass: ${name}`)));
  },
}) as Api;
