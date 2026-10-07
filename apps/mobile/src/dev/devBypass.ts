// A development-only way past sign-in, for working on screens in the emulator without an Auth0
// login or a Worker: with EXPO_PUBLIC_DEV_BYPASS=1, the app acts signed in and the API answers
// from the canned data below. scripts/emulator.ps1 turns it on.
//
// It can't reach a release build: `__DEV__` is false there, so this is always false and the
// bundler drops the code behind it.
//
// The lobby and the profile work this way, and the canned matches in devMatches.ts (open
// `match/dev-bidding` and the rest). Anything else fails with "Not in the dev bypass".
import type { MatchState } from '@fortytwo/rules';
import type { MatchPage, MatchSummary, ProfilePatch, UserProfile } from '@fortytwo/api-types';
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
  Joinable: [
    summary('open-1', ['Hank', null, 'Darla', null], 8),
    summary('open-2', ['Wes', 'Ivy', null, 'Pat'], 90),
    summary('open-3', ['Cora', null, null, null], 60 * 30),
  ],
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
  // Nothing to tell a server about this device.
  registerPushToken: () => answer(undefined),
  removePushToken: () => answer(undefined),
  // Creating or joining "works", landing on a match screen that can't load.
  createMatch: () => answer({ id: 'dev-new' } as MatchState),
  joinMatch: (id) => answer({ id } as MatchState),
  ...devMatchApi,
};

export const devApi = new Proxy(handled, {
  get: (target, name) => {
    // Not a promise, whatever awaits it.
    if (typeof name !== 'string' || name === 'then') return undefined;
    return target[name as keyof Api] ?? (() => Promise.reject(new Error(`Not in the dev bypass: ${name}`)));
  },
}) as Api;
