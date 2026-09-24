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
// locally to match exactly what GET /api/matches returns.
export interface MatchSummary {
  id: string;
  status: 'active' | 'completed';
  playerCount: number;
  updatedOn: string;
}

// Mirrors the real /api/users/* response shape (Task 15's `toUserResponse` in
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

interface ApiErrorBody {
  title?: string;
  detail?: string;
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
    throw new Error(body.detail ? `${title}: ${body.detail}` : title);
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

    joinMatch: (id: string, team: number): Promise<MatchState> =>
      request<MatchState>(getToken, `/api/matches/${id}/players`, {
        method: 'POST',
        body: JSON.stringify({ team }),
      }),

    readyUp: (id: string, ready: boolean): Promise<MatchState> =>
      request<MatchState>(getToken, `/api/matches/${id}/players`, {
        method: 'PATCH',
        body: JSON.stringify({ ready }),
      }),

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

    getProfile: (): Promise<Auth0User> => request<Auth0User>(getToken, '/api/users/profile'),

    patchProfile: (patch: { displayName?: string; theme?: string; picture?: string }): Promise<void> =>
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
