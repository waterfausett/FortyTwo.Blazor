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
  MatchSummary,
  ProfilePatch,
  PublicUser,
  UserProfile,
} from '@fortytwo/api-types';

export type { MatchSummary, PublicUser, UserProfile };

// Keeps the Worker's title and detail apart so a toast can show them as heading and body;
// `message` still joins them for callers that just print it.
export class ApiError extends Error {
  readonly title: string;
  readonly detail?: string;

  constructor(title: string, detail?: string) {
    super(detail ? `${title}: ${detail}` : title);
    this.name = 'ApiError';
    this.title = title;
    this.detail = detail;
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
    throw new ApiError(title, body.detail || undefined);
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

    listMatches: (filter: 'Active' | 'Completed' | 'Joinable'): Promise<MatchSummary[]> =>
      request<MatchSummary[]>(`/api/matches?filter=${filter}`),

    getMatch: (id: string): Promise<MatchState> => request<MatchState>(`/api/matches/${id}`),

    // `position` is the seat (0-3) the player picked.
    joinMatch: (id: string, position: number): Promise<MatchState> =>
      request<MatchState>(`/api/matches/${id}/players`, {
        method: 'POST',
        body: JSON.stringify({ position }),
      }),

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

    // Dev-only (the Worker's AUTO_PLAY_BOTS): seats a bot at `position`, or at every open seat
    // when no position is given.
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
    registerPushToken: (token: string, platform: 'android' | 'ios'): Promise<void> =>
      request<void>('/api/users/push-tokens', { method: 'PUT', body: JSON.stringify({ token, platform }) }, false),

    removePushToken: (token: string): Promise<void> =>
      request<void>('/api/users/push-tokens', { method: 'DELETE', body: JSON.stringify({ token }) }, false),
  };
}
