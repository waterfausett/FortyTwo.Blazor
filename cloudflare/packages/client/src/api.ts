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
import type { MatchState } from '@fortytwo/rules';
import type {
  ApiErrorBody,
  ClientConfig,
  MatchPage,
  MatchSummary,
  PokeResult,
  ProfilePatch,
  PublicUser,
  UserProfile,
} from '@fortytwo/api-types';

export type { MatchPage, MatchSummary, PokeResult, PublicUser, UserProfile };

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
  const res = await fetch(`${origin}${path}`, {
    ...init,
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
    createMatch: (): Promise<MatchState> => request<MatchState>('/api/matches', { method: 'POST' }),

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

    // A vote to play the same four again once the match is over.
    rematch: (id: string): Promise<MatchState> =>
      request<MatchState>(`/api/matches/${id}/rematch`, { method: 'POST' }),

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
  };
}
