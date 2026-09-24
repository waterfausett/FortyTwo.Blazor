// Tests auth0Management.ts (port of Auth0AccessTokenProvider + Auth0ApiClient) by mocking global
// fetch directly, per the task brief. The token cache is a module-level variable (mirrors the
// real C# app's IMemoryCache-backed provider - valid for the Worker isolate's lifetime), so each
// test resets the module via vi.resetModules() + a fresh dynamic import to get an unpolluted cache.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Env } from '../src/index';

const testEnv = {
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
  vi.resetModules();
  mod = await import('../src/auth0Management');
});

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
      expect(fetchMock.mock.calls[1][0]).toBe('https://test-tenant.auth0.local/api/v2/users/auth0|1');
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

      const tokenCalls = fetchMock.mock.calls.filter((call: unknown[]) => String(call[0]).includes('oauth/token'));
      expect(tokenCalls).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      vi.unstubAllGlobals();
    });

    // Correction B: the real C# check is `cachedToken.ExpiresOn > DateTimeOffset.UtcNow.AddSeconds(-30)`,
    // i.e. `now < expiresOn + 30s` - the cached token is treated as still valid for up to 30 SECONDS
    // PAST its nominal expiry, not refreshed 30s early. Port the literal comparison.
    it('treats a token up to 30s PAST its nominal expiry as still a cache hit (literal C# grace-period quirk)', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse({ expires_in: 60 }))
        .mockResolvedValueOnce(jsonResponse({ user_id: 'u1' }))
        .mockResolvedValueOnce(jsonResponse({ user_id: 'u2' }));
      vi.stubGlobal('fetch', fetchMock);

      await mod.getUser(testEnv, 'u1');
      // Nominal expiry is now+60s. Advance 89s: 29s PAST expiry - still inside the 30s grace window.
      vi.advanceTimersByTime(89_000);
      await mod.getUser(testEnv, 'u2');

      const tokenCalls = fetchMock.mock.calls.filter((call: unknown[]) => String(call[0]).includes('oauth/token'));
      expect(tokenCalls).toHaveLength(1);

      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it('refetches once more than 30s past the nominal expiry', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse({ expires_in: 60 }))
        .mockResolvedValueOnce(jsonResponse({ user_id: 'u1' }))
        .mockResolvedValueOnce(tokenResponse({ access_token: 'second-token' }))
        .mockResolvedValueOnce(jsonResponse({ user_id: 'u2' }));
      vi.stubGlobal('fetch', fetchMock);

      await mod.getUser(testEnv, 'u1');
      // Nominal expiry is now+60s. Advance 91s: 31s PAST expiry - past the 30s grace window.
      vi.advanceTimersByTime(91_000);
      await mod.getUser(testEnv, 'u2');

      const tokenCalls = fetchMock.mock.calls.filter((call: unknown[]) => String(call[0]).includes('oauth/token'));
      expect(tokenCalls).toHaveLength(2);

      vi.unstubAllGlobals();
      vi.useRealTimers();
    });
  });

  describe('getUsers', () => {
    it('with no ids requests GET api/v2/users with the base fields/include_fields filter', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse([{ user_id: 'u1' }]));
      vi.stubGlobal('fetch', fetchMock);

      const result = await mod.getUsers(testEnv);

      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://test-tenant.auth0.local/api/v2/users?fields=identities,app_metadata,last_ip&include_fields=false'
      );
      expect(result).toEqual([{ user_id: 'u1' }]);

      vi.unstubAllGlobals();
    });

    // Correction C: a distinct URL/query shape when ids are supplied - a single q=user_id:(...)
    // param, each id double-quoted, comma-separated, no spaces.
    it('with ids requests GET api/v2/users with a q=user_id:(...) filter using exact quoting', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(jsonResponse([{ user_id: 'u1' }, { user_id: 'u2' }]));
      vi.stubGlobal('fetch', fetchMock);

      await mod.getUsers(testEnv, ['u1', 'u2']);

      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://test-tenant.auth0.local/api/v2/users?fields=identities,app_metadata,last_ip&include_fields=false&q=user_id:("u1","u2")'
      );

      vi.unstubAllGlobals();
    });
  });

  describe('updateUser', () => {
    it('sends a PATCH to api/v2/users/{id} with { user_metadata: patch }, omitting unset fields', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await mod.updateUser(testEnv, 'u1', { displayName: 'Adam' });

      expect(fetchMock.mock.calls[1][0]).toBe('https://test-tenant.auth0.local/api/v2/users/u1');
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
