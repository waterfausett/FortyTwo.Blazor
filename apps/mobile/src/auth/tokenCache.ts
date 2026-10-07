// The access token, held in memory between requests. Asking the credentials manager for it is a
// trip to native code - on Android, queued on the UI thread and decrypted through the Keystore -
// which delayed every action taken on the phone. auth0-react keeps the token in memory the same
// way on web.

// Handed out until this long before it expires, so a request never goes out with a token that
// lapses on the way.
export const EXPIRY_MARGIN_MS = 60_000;

type Fetched = { accessToken: string; expiresAt: number };

let cached: { token: string; expiresAtMs: number } | null = null;
// Callers arriving while the credentials manager is being asked wait for the same answer.
let pending: Promise<string> | null = null;
// Bumped on clear, so an answer that arrives after a sign-out isn't kept.
let generation = 0;

// `expiresAt` is a UNIX timestamp in seconds, as the credentials manager returns it.
export function getCachedToken(fetch: () => Promise<Fetched>, now: () => number = Date.now): Promise<string> {
  if (cached && now() < cached.expiresAtMs - EXPIRY_MARGIN_MS) return Promise.resolve(cached.token);
  if (pending) return pending;

  const started = generation;
  const request = fetch()
    .then(({ accessToken, expiresAt }) => {
      if (started === generation) cached = { token: accessToken, expiresAtMs: expiresAt * 1000 };
      return accessToken;
    })
    .finally(() => {
      if (pending === request) pending = null;
    });
  pending = request;
  return request;
}

// Forgets the token - on signing out, or when the stored session can't be renewed.
export function clearCachedToken(): void {
  cached = null;
  pending = null;
  generation++;
}
