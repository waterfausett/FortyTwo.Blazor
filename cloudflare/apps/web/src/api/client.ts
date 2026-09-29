// Thin typed wrapper over the Worker's REST routes (apps/worker/src/routes/matches.ts and
// routes/users.ts, Tasks 14-15). Every method attaches a bearer token from the caller-supplied
// getToken() (an Auth0 `getAccessTokenSilently` in production) and throws a descriptive Error on
// any non-2xx response, surfacing the Worker's `{ title, detail }` error body (matchDO.ts's
// ValidationError -> 400 / not-found -> 404 mapping) so a caller can display it directly.
//
// MatchState is imported type-only from @fortytwo/rules: it's a data SHAPE (not executable rule
// logic), so this is erased at compile time and does not make apps/web depend on the rules engine
// at runtime - client-side rule validation stays deferred (GitHub issue #9).
import type { MatchState } from '@fortytwo/rules';

// MatchSummary is the D1 "lobby index" row shape (apps/worker/src/lobby.ts) - a Worker-internal
// module, not part of @fortytwo/rules (which only models in-DO match/game state, never the lobby
// index) and not something apps/web should reach across the app boundary to import. Mirrored
// locally to match exactly what GET /api/matches returns - plus `teams`, which the route attaches
// to each row: [TeamA, TeamB] display names, each in join order (bots, and anyone Auth0 couldn't
// resolve, appear by raw id), and `seats`, the display name at each position 0-3 (null if open).
export interface MatchSummary {
  id: string;
  status: 'active' | 'completed';
  playerCount: number;
  updatedOn: string;
  teams: [string[], string[]];
  seats: (string | null)[];
}

// Mirrors the /api/users/profile response shape (Task 15's `toUserResponse` in
// apps/worker/src/routes/users.ts): the raw Auth0 Management API fields the Worker forwards, plus
// the two fields it computes server-side (`displayName` is always present via a fallback chain;
// `picture` prefers a non-blank `user_metadata.picture` over the raw top-level `picture`).
// Defined locally rather than imported from apps/worker for the same app-boundary reason as
// MatchSummary above - apps/worker is a backend-internal module, never designed as a shared type
// surface for apps/web.
export interface Auth0User {
  user_id: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  nickname?: string;
  picture?: string;
  displayName: string;
  user_metadata?: { displayName?: string; theme?: 'Light' | 'Dark'; picture?: string };
}

// What /api/users/search returns for each player (`toPublicUser`): never their email or real name.
export type PublicUser = Pick<Auth0User, 'user_id' | 'displayName' | 'picture'>;

interface ApiErrorBody {
  title?: string;
  detail?: string;
}

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
async function request<T>(
  getToken: () => Promise<string>,
  path: string,
  init: RequestInit = {},
  parseJson = true
): Promise<T> {
  const token = await getToken();
  const res = await fetch(`${import.meta.env.VITE_API_ORIGIN}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    let body: ApiErrorBody = {};
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

export function apiClient(getToken: () => Promise<string>) {
  return {
    createMatch: (): Promise<MatchState> => request<MatchState>(getToken, '/api/matches', { method: 'POST' }),

    listMatches: (filter: 'Active' | 'Completed' | 'Joinable'): Promise<MatchSummary[]> =>
      request<MatchSummary[]>(getToken, `/api/matches?filter=${filter}`),

    getMatch: (id: string): Promise<MatchState> => request<MatchState>(getToken, `/api/matches/${id}`),

    // `position` is the seat (0-3) the player picked.
    joinMatch: (id: string, position: number): Promise<MatchState> =>
      request<MatchState>(getToken, `/api/matches/${id}/players`, {
        method: 'POST',
        body: JSON.stringify({ position }),
      }),

    readyUp: (id: string, ready: boolean): Promise<MatchState> =>
      request<MatchState>(getToken, `/api/matches/${id}/players`, {
        method: 'PATCH',
        body: JSON.stringify({ ready }),
      }),

    // A vote to play the same four again once the match is over.
    rematch: (id: string): Promise<MatchState> =>
      request<MatchState>(getToken, `/api/matches/${id}/rematch`, { method: 'POST' }),

    setTrump: (id: string, suit: number): Promise<MatchState> =>
      request<MatchState>(getToken, `/api/matches/${id}/games/current`, {
        method: 'PATCH',
        body: JSON.stringify({ suit }),
      }),

    bid: (id: string, bid: number): Promise<MatchState> =>
      request<MatchState>(getToken, `/api/matches/${id}/games/current/bids`, {
        method: 'POST',
        body: JSON.stringify({ bid }),
      }),

    playDomino: (id: string, domino: { top: number; bottom: number }): Promise<MatchState> =>
      request<MatchState>(getToken, `/api/matches/${id}/games/current/moves`, {
        method: 'POST',
        body: JSON.stringify({ domino }),
      }),

    // Dev-only (the Worker's AUTO_PLAY_BOTS): seats a bot at `position`, or at every open seat
    // when no position is given.
    addBots: (id: string, position?: number): Promise<MatchState> =>
      request<MatchState>(getToken, `/api/matches/${id}/bots`, {
        method: 'POST',
        body: JSON.stringify({ position }),
      }),

    // Feature switches the Worker turns on per environment.
    getConfig: (): Promise<{ bots: boolean }> => request<{ bots: boolean }>(getToken, '/api/config'),

    getProfile: (): Promise<Auth0User> => request<Auth0User>(getToken, '/api/users/profile'),

    // Ids with no Auth0 account (bots) are simply absent from the result.
    searchUsers: (userIds: string[]): Promise<PublicUser[]> =>
      request<PublicUser[]>(getToken, '/api/users/search', {
        method: 'POST',
        body: JSON.stringify(userIds),
      }),

    patchProfile: (patch: { displayName?: string; picture?: string }): Promise<void> =>
      request<void>(
        getToken,
        '/api/users',
        {
          method: 'PATCH',
          body: JSON.stringify(patch),
        },
        false
      ),
  };
}
