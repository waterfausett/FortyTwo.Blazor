// Port of the real C# app's Auth0AccessTokenProvider + Auth0ApiClient
// (FortyTwo/Server/Services/Auth0AccessTokenProvider.cs, Auth0ApiClient.cs). A pure Auth0
// Management API client - no response-shaping/computed-field logic here (see routes/users.ts's
// toUserResponse for that; Auth0's raw shape is returned as-is).
import type { Env } from './index';

export interface Auth0User {
  user_id: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  nickname?: string;
  // Raw top-level Auth0 field - every Auth0 user has one (Gravatar/avatar URL). Used as the
  // fallback in routes/users.ts's picture-preference logic (real C# User.Picture getter).
  picture?: string;
  user_metadata?: { displayName?: string; theme?: 'Light' | 'Dark'; picture?: string };
}

interface CachedToken {
  token: string;
  tokenType: string;
  // Epoch ms - mirrors the C# AccessToken's ExpiresOn (DateTimeOffset).
  expiresOn: number;
}

interface Auth0TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

// Module-level cache: valid for the lifetime of the Worker isolate, mirroring the C# app's
// IMemoryCache-backed provider. A cold isolate just re-fetches once.
let cachedToken: CachedToken | undefined;

// Ports Auth0AccessTokenProvider.FetchAsync literally, INCLUDING its freshness check
// (Auth0AccessTokenProvider.cs:38): `cachedToken.ExpiresOn > DateTimeOffset.UtcNow.AddSeconds(-30)`
// is equivalent to `now < expiresOn + 30s` - the cached token is treated as still valid for up to
// 30 SECONDS PAST its nominal expiry (a real quirk of the original app), not refreshed 30s early.
// Do not "fix" this to a refresh-before-expiry pattern.
async function fetchAccessToken(env: Env): Promise<CachedToken> {
  if (cachedToken && cachedToken.expiresOn > Date.now() - 30_000) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.AUTH0_API_CLIENT_ID,
    client_secret: env.AUTH0_API_CLIENT_SECRET,
    audience: env.AUTH0_API_AUDIENCE,
  });

  const response = await fetch(`https://${env.AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`Auth0 token request failed: ${response.status}`);
  }

  const json = (await response.json()) as Auth0TokenResponse;
  cachedToken = {
    token: json.access_token,
    tokenType: json.token_type,
    expiresOn: Date.now() + json.expires_in * 1000,
  };
  return cachedToken;
}

async function authorizedFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const accessToken = await fetchAccessToken(env);
  const response = await fetch(`https://${env.AUTH0_DOMAIN}/${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `${accessToken.tokenType} ${accessToken.token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Auth0 API request failed: ${response.status} ${path}`);
  }
  return response;
}

// Ports Auth0ApiClient.GetUserAsync.
export async function getUser(env: Env, userId: string): Promise<Auth0User> {
  const response = await authorizedFetch(env, `api/v2/users/${encodeURIComponent(userId)}`);
  return response.json();
}

// Auth0's user search returns at most this many users per page.
export const MAX_USER_IDS = 50;

// One term of a Lucene quoted phrase. Only `\` and `"` can end the phrase early, so escaping
// those keeps an id from rewriting the search.
function quoted(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

// Ports Auth0ApiClient.GetUsersAsync(List<string>): looks the given ids up in one search, so the
// caller splits anything over MAX_USER_IDS. include_fields=false means EXCLUDE the listed `fields`
// from the response - an odd-looking but real filter, ported as-is.
export async function getUsers(env: Env, userIds: string[]): Promise<Auth0User[]> {
  if (userIds.length === 0) return [];
  if (userIds.length > MAX_USER_IDS) {
    throw new Error(`getUsers takes at most ${MAX_USER_IDS} ids, got ${userIds.length}`);
  }
  const query = new URLSearchParams({
    fields: 'identities,app_metadata,last_ip',
    include_fields: 'false',
    q: `user_id:(${userIds.map(quoted).join(',')})`,
  });
  const response = await authorizedFetch(env, `api/v2/users?${query}`);
  return response.json();
}

// Ports Auth0ApiClient.UpdateUserAsync. JSON.stringify already omits `undefined`-valued keys, so
// as long as `patch`'s unset fields are genuinely `undefined` (not `null`), this matches the C#
// DefaultIgnoreCondition = WhenWritingNull partial-update behavior for free (Correction F).
export async function updateUser(
  env: Env,
  userId: string,
  patch: { displayName?: string; picture?: string }
): Promise<void> {
  await authorizedFetch(env, `api/v2/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_metadata: patch }),
  });
}
