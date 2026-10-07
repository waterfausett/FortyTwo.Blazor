// Tests auth0Management.ts by mocking global fetch directly. The token is cached in a module-level
// variable (one isolate's memory) and in D1's auth0_tokens table (shared by every isolate), so each
// test empties the table and resets the module via vi.resetModules() + a fresh dynamic import.
// Re-importing the module is also how a test plays a new isolate.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index';

const testEnv = {
  DB: env.DB,
  AUTH0_DOMAIN: 'test-tenant.auth0.local',
  AUTH0_AUDIENCE: 'https://api.test.local',
  AUTH0_API_CLIENT_ID: 'test-client-id',
  AUTH0_API_CLIENT_SECRET: 'test-client-secret',
  AUTH0_API_AUDIENCE: 'https://api.test.local/mgmt',
} as unknown as Env;

function tokenResponse(
  overrides: Partial<{ access_token: string; expires_in: number; token_type: string }> = {}
) {
  return new Response(
    JSON.stringify({
      access_token: overrides.access_token ?? 'test-access-token',
      expires_in: overrides.expires_in ?? 86400,
      token_type: overrides.token_type ?? 'Bearer',
      scope: 'read:users update:users',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let mod: typeof import('../src/auth0Management');

beforeEach(async () => {
  vi.useRealTimers();
  await env.DB.exec('DELETE FROM auth0_tokens');
  vi.resetModules();
  mod = await import('../src/auth0Management');
});

function tokenCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call: unknown[]) => String(call[0]).includes('oauth/token')).length;
}

describe('auth0Management', () => {
  describe('getUser', () => {
    it('fetches an access token then requests GET api/v2/users/{id} with a bearer token', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse({ user_id: 'auth0|1', email: 'a@example.com' }));
      vi.stubGlobal('fetch', fetchMock);

      const user = await mod.getUser(testEnv, 'auth0|1');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe('https://test-tenant.auth0.local/oauth/token');
      expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
      expect(fetchMock.mock.calls[1][0]).toBe('https://test-tenant.auth0.local/api/v2/users/auth0%7C1');
      const headers = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-access-token');
      expect(user.user_id).toBe('auth0|1');

      vi.unstubAllGlobals();
    });

    it('reuses the cached token for a second call within the token lifetime (cache hit - no second oauth/token call)', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse({ user_id: 'u1' }))
        .mockResolvedValueOnce(jsonResponse({ user_id: 'u2' }));
      vi.stubGlobal('fetch', fetchMock);

      await mod.getUser(testEnv, 'u1');
      await mod.getUser(testEnv, 'u2');

      expect(tokenCallCount(fetchMock)).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      vi.unstubAllGlobals();
    });

    // A token is refreshed 30s BEFORE its nominal expiry, so no request carries one that's about
    // to lapse.
    it('reuses the token until 30s before its nominal expiry', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse({ expires_in: 60 }))
        .mockResolvedValueOnce(jsonResponse({ user_id: 'u1' }))
        .mockResolvedValueOnce(jsonResponse({ user_id: 'u2' }));
      vi.stubGlobal('fetch', fetchMock);

      await mod.getUser(testEnv, 'u1');
      // Nominal expiry is now+60s. Advance 29s: 31s left, outside the 30s margin.
      vi.advanceTimersByTime(29_000);
      await mod.getUser(testEnv, 'u2');

      expect(tokenCallCount(fetchMock)).toBe(1);

      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it('fetches a new token once inside the 30s before expiry, and uses it', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse({ expires_in: 60 }))
        .mockResolvedValueOnce(jsonResponse({ user_id: 'u1' }))
        .mockResolvedValueOnce(tokenResponse({ access_token: 'second-token' }))
        .mockResolvedValueOnce(jsonResponse({ user_id: 'u2' }));
      vi.stubGlobal('fetch', fetchMock);

      await mod.getUser(testEnv, 'u1');
      // Nominal expiry is now+60s. Advance 31s: 29s left, inside the 30s margin.
      vi.advanceTimersByTime(31_000);
      await mod.getUser(testEnv, 'u2');

      expect(tokenCallCount(fetchMock)).toBe(2);
      const headers = fetchMock.mock.calls[3][1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer second-token');

      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it('shares the token with a new isolate through D1 instead of fetching another', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse({ access_token: 'shared-token' }))
        .mockResolvedValueOnce(jsonResponse({ user_id: 'u1' }))
        .mockResolvedValueOnce(jsonResponse({ user_id: 'u2' }));
      vi.stubGlobal('fetch', fetchMock);

      await mod.getUser(testEnv, 'u1');
      vi.resetModules();
      const freshIsolate = await import('../src/auth0Management');
      await freshIsolate.getUser(testEnv, 'u2');

      expect(tokenCallCount(fetchMock)).toBe(1);
      const headers = fetchMock.mock.calls[2][1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer shared-token');

      vi.unstubAllGlobals();
    });

    it('fetches a new token when the one in D1 is about to expire, and stores it for the others', async () => {
      await env.DB.prepare(
        'INSERT INTO auth0_tokens (audience, token, token_type, expires_on) VALUES (?1, ?2, ?3, ?4)'
      )
        .bind(testEnv.AUTH0_API_AUDIENCE, 'stale-token', 'Bearer', Date.now() + 10_000)
        .run();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse({ access_token: 'new-token' }))
        .mockResolvedValueOnce(jsonResponse({ user_id: 'u1' }));
      vi.stubGlobal('fetch', fetchMock);

      await mod.getUser(testEnv, 'u1');

      expect(tokenCallCount(fetchMock)).toBe(1);
      const stored = await env.DB.prepare('SELECT token FROM auth0_tokens WHERE audience = ?1')
        .bind(testEnv.AUTH0_API_AUDIENCE)
        .first<{ token: string }>();
      expect(stored?.token).toBe('new-token');

      vi.unstubAllGlobals();
    });

    it('asks Auth0 once when requests in one isolate need a token at the same time', async () => {
      const fetchMock = vi.fn((url: string) =>
        Promise.resolve(url.includes('oauth/token') ? tokenResponse() : jsonResponse({ user_id: 'u' }))
      );
      vi.stubGlobal('fetch', fetchMock);

      await Promise.all([mod.getUser(testEnv, 'u1'), mod.getUser(testEnv, 'u2'), mod.getUser(testEnv, 'u3')]);

      expect(tokenCallCount(fetchMock)).toBe(1);

      vi.unstubAllGlobals();
    });
  });

  describe('getUsers', () => {
    // The search query the request carried, decoded.
    function searchParams(fetchMock: ReturnType<typeof vi.fn>): URLSearchParams {
      return new URL(String(fetchMock.mock.calls[1][0])).searchParams;
    }

    // A single q=user_id:(...) param, each id double-quoted, comma-separated, no spaces.
    it('requests GET api/v2/users with a q=user_id:(...) filter using exact quoting', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse([{ user_id: 'u1' }, { user_id: 'u2' }]));
      vi.stubGlobal('fetch', fetchMock);

      const result = await mod.getUsers(testEnv, ['auth0|u1', 'u2']);

      const url = new URL(String(fetchMock.mock.calls[1][0]));
      expect(`${url.origin}${url.pathname}`).toBe('https://test-tenant.auth0.local/api/v2/users');
      const params = searchParams(fetchMock);
      expect(params.get('fields')).toBe('identities,app_metadata,last_ip');
      expect(params.get('include_fields')).toBe('false');
      expect(params.get('q')).toBe('user_id:("auth0|u1","u2")');
      expect(result).toEqual([{ user_id: 'u1' }, { user_id: 'u2' }]);

      vi.unstubAllGlobals();
    });

    it("escapes quotes and backslashes so an id can't break out of its phrase", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse([]));
      vi.stubGlobal('fetch', fetchMock);

      await mod.getUsers(testEnv, ['x") OR user_id:(*', 'a\\']);

      expect(searchParams(fetchMock).get('q')).toBe('user_id:("x\\") OR user_id:(*","a\\\\")');

      vi.unstubAllGlobals();
    });

    it('returns no users without calling Auth0 when given no ids', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      expect(await mod.getUsers(testEnv, [])).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it('refuses more ids than one page of results holds', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const ids = Array.from({ length: mod.MAX_USER_IDS + 1 }, (_, i) => `u${i}`);
      await expect(mod.getUsers(testEnv, ids)).rejects.toThrow(/at most 50/);
      expect(fetchMock).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });
  });

  describe('updateUser', () => {
    it('sends a PATCH to api/v2/users/{id} with { user_metadata: patch }, omitting unset fields', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(Response.json({ user_id: 'auth0|u1', user_metadata: { displayName: 'Adam' } }));
      vi.stubGlobal('fetch', fetchMock);

      const user = await mod.updateUser(testEnv, 'auth0|u1', { displayName: 'Adam' });

      expect(user).toEqual({ user_id: 'auth0|u1', user_metadata: { displayName: 'Adam' } });

      expect(fetchMock.mock.calls[1][0]).toBe('https://test-tenant.auth0.local/api/v2/users/auth0%7Cu1');
      const init = fetchMock.mock.calls[1][1] as RequestInit;
      expect(init.method).toBe('PATCH');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ user_metadata: { displayName: 'Adam' } });
      expect(body.user_metadata).not.toHaveProperty('theme');
      expect(body.user_metadata).not.toHaveProperty('picture');

      vi.unstubAllGlobals();
    });
  });
});
