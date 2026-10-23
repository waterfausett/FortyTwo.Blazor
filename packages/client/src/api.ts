// Thin typed wrapper over the Worker's REST routes (apps/worker/src/routes/matches.ts and
// routes/users.ts). Every method attaches a bearer token from the caller-supplied getToken() (an
// Auth0 `getAccessTokenSilently` in production) and throws an ApiError on any non-2xx response,
// carrying the Worker's `{ title, detail }` error body so a caller can display it directly.
//
// Requests go to the caller-supplied origin: empty for the web app, which the Worker serves on its
// own origin, and the Worker's absolute URL for a native app, which has no origin of its own.
//
// Response shapes come from @fortytwo/api-types, shared with the Worker, and MatchState from
// @fortytwo/rules.
import type { HouseRules, MatchState } from '@fortytwo/rules';
import type {
  ApiErrorBody,
  ClientConfig,
  HintResponse,
  Invite,
  InviteResult,
  MatchPage,
  MatchSummary,
  PeopleView,
  Person,
  PlayerStats,
  PokeResult,
  ProfilePatch,
  PublicUser,
  UserProfile,
} from '@fortytwo/api-types';

export type { HintResponse, Invite, InviteResult, MatchPage, MatchSummary, PeopleView, Person, PlayerStats, PokeResult, PublicUser, UserProfile };

// Keeps the Worker's title and detail apart so a toast can show them as heading and body;
// `message` still joins them for callers that just print it.
export class ApiError extends Error {
  readonly title: string;
  readonly detail?: string;
  // The response's HTTP status, when the error came from one.
  readonly status?: number;

  constructor(title: string, detail?: string, status?: number) {
    super(detail ? `${title}: ${detail}` : title);
    this.name = 'ApiError';
    this.title = title;
    this.detail = detail;
    this.status = status;
  }
}

// How long a request gets before it's given up as a timeout, so a dead connection ends in an error
// the caller can show rather than a spinner that never stops.
export const REQUEST_TIMEOUT_MS = 15_000;

// `parseJson: false` is for routes that respond with an empty body (patchProfile's underlying
// route does `c.body(null, 200)`) - calling `res.json()` on an empty body throws, so those callers
// opt out entirely rather than relying on a content-length/204 heuristic that may not hold across
// every fetch implementation this runs under (browser fetch, undici in tests, etc.).
async function requestFrom<T>(
  getToken: () => Promise<string>,
  origin: string,
  path: string,
  init: RequestInit = {},
  parseJson = true
): Promise<T> {
  const token = await getToken();
  // A timer and AbortController rather than AbortSignal.timeout, which React Native lacks.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await send<T>(origin, path, init, token, abort.signal, parseJson);
  } catch (error) {
    if (abort.signal.aborted) throw new ApiError('Request timed out', 'Check your connection and try again.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function send<T>(
  origin: string,
  path: string,
  init: RequestInit,
  token: string,
  signal: AbortSignal,
  parseJson: boolean
): Promise<T> {
  const res = await fetch(`${origin}${path}`, {
    ...init,
    signal,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    let body: Partial<ApiErrorBody> = {};
    try {
      body = await res.json();
    } catch {
      // Non-JSON error body (e.g. requireAuth's raw-text 401) - fall through with an empty body
      // so the title/detail fallback below still produces a useful message.
    }
    const title = body.title?.trim() || res.statusText || `Request failed (${res.status})`;
    throw new ApiError(title, body.detail || undefined, res.status);
  }

  if (!parseJson) return undefined as T;
  return (await res.json()) as T;
}

// `origin` is prefixed to every path, e.g. `https://fortytwo.example.com`; '' means relative URLs.
export function createApiClient(getToken: () => Promise<string>, origin: string) {
  const request = <T>(path: string, init?: RequestInit, parseJson?: boolean): Promise<T> =>
    requestFrom<T>(getToken, origin, path, init, parseJson);

  return {
    // A custom table, on the given house rules or the defaults.
    createMatch: (rules?: HouseRules): Promise<MatchState> =>
      request<MatchState>('/api/matches', { method: 'POST', ...(rules ? { body: JSON.stringify({ rules }) } : {}) }),

    // Live or Async play: seats the caller at an open table of that mode, or starts one.
    play: (mode: 'live' | 'daily'): Promise<MatchState> =>
      request<MatchState>('/api/matchmaking', { method: 'POST', body: JSON.stringify({ mode }) }),

    // A match against three bots, dealt and under way: the caller in seat 0, bots in the rest.
    playBots: (): Promise<MatchState> => request<MatchState>('/api/matches/bots', { method: 'POST' }),

    // One page of a lobby list; pass the previous page's `nextCursor` for the next one.
    listMatches: (filter: 'Active' | 'Completed' | 'Joinable', cursor?: string): Promise<MatchPage> =>
      request<MatchPage>(`/api/matches?filter=${filter}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),

    getMatch: (id: string): Promise<MatchState> => request<MatchState>(`/api/matches/${id}`),

    // `position` is the seat (0-3) the player picked.
    joinMatch: (id: string, position: number): Promise<MatchState> =>
      request<MatchState>(`/api/matches/${id}/players`, {
        method: 'POST',
        body: JSON.stringify({ position }),
      }),

    // Leaves a match before its first deal; the last human out deletes it. The reply is the match
    // (someone's still seated) or empty (deleted) - the caller navigates away either way.
    leaveMatch: (id: string): Promise<void> =>
      request<void>(`/api/matches/${id}/players`, { method: 'DELETE' }, false),

    readyUp: (id: string, ready: boolean): Promise<MatchState> =>
      request<MatchState>(`/api/matches/${id}/players`, {
        method: 'PATCH',
        body: JSON.stringify({ ready }),
      }),

    // Takes the caller's seat back from the bot after a Live turn ran out.
    resume: (id: string): Promise<MatchState> =>
      request<MatchState>(`/api/matches/${id}/players`, { method: 'PATCH', body: JSON.stringify({ autopilot: false }) }),

    // A vote to play the same four again once the match is over.
    rematch: (id: string): Promise<MatchState> =>
      request<MatchState>(`/api/matches/${id}/rematch`, { method: 'POST' }),

    // At the end of a Live game: offer to search together with your partner, take the offer back,
    // or go and find a game of your own.
    partyUp: (id: string): Promise<MatchState> =>
      request<MatchState>(`/api/matches/${id}/party`, { method: 'POST' }),

    cancelParty: (id: string): Promise<MatchState> =>
      request<MatchState>(`/api/matches/${id}/party`, { method: 'DELETE' }),

    moveOn: (id: string): Promise<MatchState> =>
      request<MatchState>(`/api/matches/${id}/move-on`, { method: 'POST' }),

    setTrump: (id: string, suit: number): Promise<MatchState> =>
      request<MatchState>(`/api/matches/${id}/games/current`, {
        method: 'PATCH',
        body: JSON.stringify({ suit }),
      }),

    bid: (id: string, bid: number): Promise<MatchState> =>
      request<MatchState>(`/api/matches/${id}/games/current/bids`, {
        method: 'POST',
        body: JSON.stringify({ bid }),
      }),

    playDomino: (id: string, domino: { top: number; bottom: number }): Promise<MatchState> =>
      request<MatchState>(`/api/matches/${id}/games/current/moves`, {
        method: 'POST',
        body: JSON.stringify({ domino }),
      }),

    // Nudges the player whose turn it is, once it has waited long enough (poke.ts). Resolves with
    // how it reached them - `'none'` when it couldn't, which leaves the turn's poke unused.
    poke: (id: string): Promise<PokeResult> => request<PokeResult>(`/api/matches/${id}/poke`, { method: 'POST' }),

    // What the ML bot would do in my seat, in a practice match: { status: 'warming' } while the
    // Worker's model loads (ask again - fetchHint does), 'unavailable' if it can't, or the hint.
    getHint: (id: string): Promise<HintResponse> => request<HintResponse>(`/api/matches/${id}/games/current/hint`),

    // Seats a bot at `position`, or at every open seat when no position is given (the Worker
    // answers 404 when its BOTS_ENABLED is 'false').
    addBots: (id: string, position?: number): Promise<MatchState> =>
      request<MatchState>(`/api/matches/${id}/bots`, {
        method: 'POST',
        body: JSON.stringify({ position }),
      }),

    // Feature switches the Worker turns on per environment.
    getConfig: (): Promise<ClientConfig> => request<ClientConfig>('/api/config'),

    getProfile: (): Promise<UserProfile> => request<UserProfile>('/api/users/profile'),

    // The caller's own lifetime stats, for the Profile.
    getStats: (): Promise<PlayerStats> => request<PlayerStats>('/api/users/stats'),

    // Ids with no Auth0 account (bots) are simply absent from the result.
    searchUsers: (userIds: string[]): Promise<PublicUser[]> =>
      request<PublicUser[]>('/api/users/search', {
        method: 'POST',
        body: JSON.stringify(userIds),
      }),

    patchProfile: (patch: ProfilePatch): Promise<void> =>
      request<void>(
        '/api/users',
        {
          method: 'PATCH',
          body: JSON.stringify(patch),
        },
        false
      ),

    // This device's Expo push token, so the player's turns and the like reach it as push
    // notifications (the mobile app only). Registering a token another account had moves it here.
    // `drawsOwn`: the app draws the notices with buttons itself, so the Worker sends them headless.
    registerPushToken: (token: string, platform: 'android' | 'ios', drawsOwn = false): Promise<void> =>
      request<void>('/api/users/push-tokens', { method: 'PUT', body: JSON.stringify({ token, platform, drawsOwn }) }, false),

    removePushToken: (token: string): Promise<void> =>
      request<void>('/api/users/push-tokens', { method: 'DELETE', body: JSON.stringify({ token }) }, false),

    // Deletes the caller's account for good (DELETE /api/users/me). Safe to retry if it fails.
    deleteAccount: (): Promise<void> => request<void>('/api/users/me', { method: 'DELETE' }, false),

    // The People list: friends, then recent players, or just one of the two (GET /api/people).
    getPeople: (show?: PeopleView): Promise<Person[]> => request<Person[]>(show ? `/api/people?show=${show}` : '/api/people'),

    // Players whose name starts with `q` (2-40 characters).
    searchPeople: (q: string): Promise<Person[]> =>
      request<Person[]>(`/api/people/search?q=${encodeURIComponent(q)}`),

    // Friends are one-way: the other player isn't told.
    addFriend: (userId: string): Promise<void> =>
      request<void>(`/api/people/friends/${encodeURIComponent(userId)}`, { method: 'PUT' }, false),

    removeFriend: (userId: string): Promise<void> =>
      request<void>(`/api/people/friends/${encodeURIComponent(userId)}`, { method: 'DELETE' }, false),

    // Invites players to a custom table the caller is seated at; resolves with who was invited.
    invitePlayers: (matchId: string, userIds: string[]): Promise<InviteResult> =>
      request<InviteResult>(`/api/matches/${matchId}/invites`, { method: 'POST', body: JSON.stringify({ userIds }) }),

    // Invites waiting for the caller, for the Lobby's Invited to card.
    getInvites: (): Promise<Invite[]> => request<Invite[]>('/api/invites'),

    dismissInvite: (matchId: string): Promise<void> =>
      request<void>(`/api/invites/${matchId}`, { method: 'DELETE' }, false),
  };
}
