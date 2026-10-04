// A client for Auth0's Management API, authenticated with the Worker's own client credentials.
// Users come back in Auth0's raw shape; routes/users.ts's toUserResponse works out what to show.
import type { Env } from './index';
import type { Auth0User, ProfilePatch } from '@fortytwo/api-types';

export type { Auth0User };

interface CachedToken {
  token: string;
  tokenType: string;
  // Epoch ms.
  expiresOn: number;
}

interface Auth0TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

// Refresh this long before the token's nominal expiry, so a request never carries a token that
// expires while it's in flight.
const REFRESH_MARGIN_MS = 30_000;

function isFresh(token: CachedToken | undefined): token is CachedToken {
  return token !== undefined && token.expiresOn - REFRESH_MARGIN_MS > Date.now();
}

// Two layers: this isolate's memory, then D1 (the auth0_tokens table), which every isolate shares.
// Auth0 limits how many M2M tokens a tenant gets each month, and Cloudflare starts isolates often,
// so a new isolate takes the token from D1 rather than asking Auth0 for another.
let cachedToken: CachedToken | undefined;

async function readStoredToken(env: Env): Promise<CachedToken | undefined> {
  const row = await env.DB.prepare(
    'SELECT token, token_type, expires_on FROM auth0_tokens WHERE audience = ?1'
  )
    .bind(env.AUTH0_API_AUDIENCE)
    .first<{ token: string; token_type: string; expires_on: number }>();
  return row ? { token: row.token, tokenType: row.token_type, expiresOn: row.expires_on } : undefined;
}

async function storeToken(env: Env, token: CachedToken): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO auth0_tokens (audience, token, token_type, expires_on) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (audience) DO UPDATE SET token = ?2, token_type = ?3, expires_on = ?4`
  )
    .bind(env.AUTH0_API_AUDIENCE, token.token, token.tokenType, token.expiresOn)
    .run();
}

async function requestToken(env: Env): Promise<CachedToken> {
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
  return {
    token: json.access_token,
    tokenType: json.token_type,
    expiresOn: Date.now() + json.expires_in * 1000,
  };
}

async function loadAccessToken(env: Env): Promise<CachedToken> {
  const stored = await readStoredToken(env);
  if (isFresh(stored)) return stored;

  const token = await requestToken(env);
  await storeToken(env, token);
  return token;
}

// Concurrent requests in one isolate share a single lookup instead of each fetching a token.
let pendingToken: Promise<CachedToken> | undefined;

async function fetchAccessToken(env: Env): Promise<CachedToken> {
  if (isFresh(cachedToken)) return cachedToken;

  pendingToken ??= loadAccessToken(env).finally(() => {
    pendingToken = undefined;
  });
  cachedToken = await pendingToken;
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

// Looks the given ids up in one search, so the caller splits anything over MAX_USER_IDS.
// include_fields=false means EXCLUDE the listed `fields` from the response.
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

// Auth0 merges `user_metadata`, so this only changes the fields `patch` sets: JSON.stringify drops
// `undefined` keys (an unset field must be `undefined`, not `null`, or it would be cleared).
export async function updateUser(env: Env, userId: string, patch: ProfilePatch): Promise<void> {
  await authorizedFetch(env, `api/v2/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_metadata: patch }),
  });
}
