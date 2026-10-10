// The /api/users routes through the real Worker (Auth0 mocked via fetchMock), plus unit tests for
// toUserResponse's two fallback chains (picture and displayName) and toPublicUser's trimmed shape.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { fetchMock } from './fetchMock';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import { toPublicUser, toUserResponse } from '../src/routes/users';
import type { Auth0User } from '../src/auth0Management';
import { saveUsers } from '../src/users/publicUsers';

// Must match the AUTH0_DOMAIN/AUTH0_AUDIENCE test-pool bindings in vitest.config.ts, as in
// routes.matches.test.ts.
const AUTH0_DOMAIN = 'test-tenant.auth0.local';
const AUTH0_AUDIENCE = 'https://api.test.local';
const KEY_ID = 'routes-users-test-key';

let privateKey: KeyLike;

beforeAll(async () => {
  const { publicKey, privateKey: generatedPrivateKey } = await generateKeyPair('RS256');
  privateKey = generatedPrivateKey;

  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = KEY_ID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  fetchMock.activate();
  fetchMock.disableNetConnect();
  const auth0 = fetchMock.get(`https://${AUTH0_DOMAIN}`);
  auth0
    .intercept({ path: '/.well-known/jwks.json', method: 'GET' })
    .reply(200, JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } })
    .persist();
  // The Management API token is cached (in memory and in D1), so a test can't count on asking for one.
  auth0
    .intercept({ path: '/oauth/token', method: 'POST' })
    .reply(200, JSON.stringify({ access_token: 'mgmt-token', expires_in: 3600, token_type: 'Bearer' }), {
      headers: { 'content-type': 'application/json' },
    })
    .persist();
});

async function signToken(sub: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setSubject(sub)
    .setIssuer(`https://${AUTH0_DOMAIN}/`)
    .setAudience(AUTH0_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

async function api(path: string, sub: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      Authorization: `Bearer ${await signToken(sub)}`,
    },
  });
}

async function titleAndDetail(res: Response): Promise<{ title: string; detail: string }> {
  return (await res.json()) as { title: string; detail: string };
}

// Answers the next Auth0 user search with `users`, recording the search it was sent.
function mockUserSearch(users: Auth0User[]): { query?: string } {
  const seen: { query?: string } = {};
  fetchMock
    .get(`https://${AUTH0_DOMAIN}`)
    .intercept({ path: (path: string) => path.startsWith('/api/v2/users?'), method: 'GET' })
    .reply((opts) => {
      seen.query = new URL(String(opts.path), 'https://x').searchParams.get('q') ?? undefined;
      return { statusCode: 200, data: JSON.stringify(users), responseOptions: { headers: { 'content-type': 'application/json' } } };
    });
  return seen;
}

// Answers the next Auth0 user PATCH, recording the body it was sent.
function mockUserPatch(): { path?: string; body?: unknown } {
  const seen: { path?: string; body?: unknown } = {};
  fetchMock
    .get(`https://${AUTH0_DOMAIN}`)
    .intercept({ path: (path: string) => path.startsWith('/api/v2/users/'), method: 'PATCH' })
    .reply((opts) => {
      seen.path = String(opts.path);
      seen.body = JSON.parse(String(opts.body));
      const userId = decodeURIComponent(seen.path.slice('/api/v2/users/'.length));
      const user = { user_id: userId, picture: 'https://example.com/auth0.png', ...(seen.body as object) };
      return { statusCode: 200, data: JSON.stringify(user), responseOptions: { headers: { 'content-type': 'application/json' } } };
    });
  return seen;
}

// Answers the next Auth0 single-user fetch with `user`.
function mockGetUser(user: Auth0User): void {
  fetchMock
    .get(`https://${AUTH0_DOMAIN}`)
    .intercept({ path: `/api/v2/users/${encodeURIComponent(user.user_id)}`, method: 'GET' })
    .reply(200, JSON.stringify(user), { headers: { 'content-type': 'application/json' } });
}

async function storedName(id: string): Promise<{ display_name: string; picture: string | null } | null> {
  return env.DB.prepare('SELECT display_name, picture FROM users WHERE id = ?1')
    .bind(id)
    .first<{ display_name: string; picture: string | null }>();
}

describe('user routes', () => {
  it('does not list every user in the tenant', async () => {
    const res = await api('/api/users', 'auth0|p1');
    expect(res.status).toBe(404);
  });

  describe('POST /api/users/search', () => {
    // D1 lasts the whole file, so forget the players earlier tests stored.
    beforeEach(async () => {
      await env.DB.exec('DELETE FROM users');
    });

    it("returns only other players' public fields", async () => {
      mockUserSearch([
        {
          user_id: 'auth0|p2',
          email: 'p2@example.com',
          name: 'Pat Two',
          given_name: 'Pat',
          family_name: 'Two',
          nickname: 'p2',
          picture: 'https://example.com/p2.png',
          user_metadata: { displayName: 'Player Two' },
        },
      ]);

      const res = await api('/api/users/search', 'auth0|p1', { method: 'POST', body: JSON.stringify(['auth0|p2']) });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([
        { user_id: 'auth0|p2', displayName: 'Player Two', picture: 'https://example.com/p2.png' },
      ]);
    });

    it('asks Auth0 once per unknown player, never for bots', async () => {
      const seen = mockUserSearch([]);
      const res = await api('/api/users/search', 'auth0|p1', {
        method: 'POST',
        body: JSON.stringify(['auth0|p2', 'bot-1', 'auth0|p2']),
      });
      expect(seen.query).toBe('user_id:("auth0|p2")');
      expect(await res.json()).toEqual([{ user_id: 'bot-1', displayName: 'Bot 1' }]);
    });

    it('answers from D1 for players it has seen, without asking Auth0', async () => {
      await saveUsers(env.DB, [{ user_id: 'auth0|p2', displayName: 'Stored Two' }]);
      // No search mock: with net connect disabled, an Auth0 call would fail and leave p2 out.
      const res = await api('/api/users/search', 'auth0|p1', { method: 'POST', body: JSON.stringify(['auth0|p2']) });
      expect(await res.json()).toEqual([{ user_id: 'auth0|p2', displayName: 'Stored Two' }]);
    });

    it('keeps what Auth0 finds for next time', async () => {
      mockUserSearch([{ user_id: 'auth0|p2', nickname: 'two', picture: 'https://example.com/p2.png' }]);
      await api('/api/users/search', 'auth0|p1', { method: 'POST', body: JSON.stringify(['auth0|p2']) });
      expect(await storedName('auth0|p2')).toEqual({ display_name: 'two', picture: 'https://example.com/p2.png' });
    });

    it("leaves out ids Auth0 doesn't know", async () => {
      mockUserSearch([{ user_id: 'auth0|p2', nickname: 'two' }]);
      const res = await api('/api/users/search', 'auth0|p1', {
        method: 'POST',
        body: JSON.stringify(['auth0|p2', 'auth0|gone']),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([{ user_id: 'auth0|p2', displayName: 'two' }]);
    });

    it('asks the client to try again when Auth0 fails for a player D1 has not seen', async () => {
      await saveUsers(env.DB, [{ user_id: 'auth0|p2', displayName: 'Stored Two' }]);
      fetchMock
        .get(`https://${AUTH0_DOMAIN}`)
        .intercept({ path: (path: string) => path.startsWith('/api/v2/users?'), method: 'GET' })
        .reply(500, 'down');
      const res = await api('/api/users/search', 'auth0|p1', {
        method: 'POST',
        body: JSON.stringify(['auth0|p2', 'auth0|p3']),
      });
      expect(res.status).toBe(503);
      expect((await titleAndDetail(res)).title).toBe('Try again');
    });

    it.each([
      ['a quote', ['x") OR user_id:(*']],
      ['whitespace', ['auth0|p2 OR *']],
      ['a non-string', [42]],
      ['an object body', { ids: ['auth0|p2'] }],
    ])('rejects %s with a 400', async (_, body) => {
      const res = await api('/api/users/search', 'auth0|p1', { method: 'POST', body: JSON.stringify(body) });
      expect(res.status).toBe(400);
      expect((await titleAndDetail(res)).title).toBe('Invalid request');
    });

    it('rejects more than 50 ids', async () => {
      const ids = Array.from({ length: 51 }, (_, i) => `auth0|p${i}`);
      const res = await api('/api/users/search', 'auth0|p1', { method: 'POST', body: JSON.stringify(ids) });
      expect(res.status).toBe(400);
      expect((await titleAndDetail(res)).detail).toMatch(/at most 50/);
    });
  });

  describe('GET /api/users/profile', () => {
    it("keeps the caller's name and picture in D1", async () => {
      mockGetUser({ user_id: 'auth0|p1', picture: 'https://example.com/p1.png', user_metadata: { displayName: 'One' } });
      const res = await api('/api/users/profile', 'auth0|p1');
      expect(res.status).toBe(200);
      expect(await storedName('auth0|p1')).toEqual({ display_name: 'One', picture: 'https://example.com/p1.png' });
    });

    it('still returns the profile when saving the name fails', async () => {
      await env.DB.exec('ALTER TABLE users RENAME TO users_gone');
      try {
        mockGetUser({ user_id: 'auth0|p1', user_metadata: { displayName: 'One' } });
        const res = await api('/api/users/profile', 'auth0|p1');
        expect(res.status).toBe(200);
        expect(((await res.json()) as { displayName: string }).displayName).toBe('One');
      } finally {
        await env.DB.exec('ALTER TABLE users_gone RENAME TO users');
      }
    });
  });

  describe('PATCH /api/users', () => {
    it('updates the name other players see', async () => {
      mockUserPatch();
      await api('/api/users', 'auth0|p1', { method: 'PATCH', body: JSON.stringify({ displayName: 'New One' }) });
      expect(await storedName('auth0|p1')).toEqual({ display_name: 'New One', picture: 'https://example.com/auth0.png' });
    });

    it('stores only the known fields, trimmed, for the caller', async () => {
      const seen = mockUserPatch();

      const res = await api('/api/users', 'auth0|p1', {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: '  Player One ',
          picture: 'https://example.com/me.png',
          theme: 'Dark',
          admin: true,
        }),
      });

      expect(res.status).toBe(200);
      expect(seen.path).toBe('/api/v2/users/auth0%7Cp1');
      expect(seen.body).toEqual({
        user_metadata: { displayName: 'Player One', picture: 'https://example.com/me.png' },
      });
    });

    it('stores the highlight-playable setting', async () => {
      const seen = mockUserPatch();
      const res = await api('/api/users', 'auth0|p1', {
        method: 'PATCH',
        body: JSON.stringify({ highlightPlayable: true }),
      });
      expect(res.status).toBe(200);
      expect(seen.body).toEqual({ user_metadata: { highlightPlayable: true } });
    });

    it('stores the push notifications setting', async () => {
      const seen = mockUserPatch();
      const res = await api('/api/users', 'auth0|p1', {
        method: 'PATCH',
        body: JSON.stringify({ pushNotifications: false }),
      });
      expect(res.status).toBe(200);
      expect(seen.body).toEqual({ user_metadata: { pushNotifications: false } });
    });

    it('lets a blank picture clear the custom one', async () => {
      const seen = mockUserPatch();
      const res = await api('/api/users', 'auth0|p1', { method: 'PATCH', body: JSON.stringify({ picture: '' }) });
      expect(res.status).toBe(200);
      expect(seen.body).toEqual({ user_metadata: { picture: '' } });
    });

    it.each([
      ['a blank display name', { displayName: '   ' }],
      ['a display name over 50 characters', { displayName: 'x'.repeat(51) }],
      ['a display name with control characters', { displayName: 'Bad\u0007Name' }],
      ['a non-string display name', { displayName: 7 }],
      ['a javascript: picture', { picture: 'javascript:alert(1)' }],
      ['an http: picture', { picture: 'http://example.com/me.png' }],
      ['a picture that is not a URL', { picture: 'me.png' }],
      ['an over-long picture URL', { picture: `https://example.com/${'x'.repeat(2048)}` }],
      ['an array body', ['displayName']],
      ['a non-boolean highlight setting', { highlightPlayable: 'yes' }],
      ['a non-boolean push notifications setting', { pushNotifications: 1 }],
    ])('rejects %s with a 400', async (_, body) => {
      const res = await api('/api/users', 'auth0|p1', { method: 'PATCH', body: JSON.stringify(body) });
      expect(res.status).toBe(400);
      expect((await titleAndDetail(res)).title).toBe('Invalid request');
    });
  });
});

describe('push tokens', () => {
  const token = 'ExponentPushToken[abc123]';
  const tokensOf = async (userId: string) =>
    (
      await env.DB.prepare('SELECT token, platform FROM push_tokens WHERE user_id = ?1').bind(userId).all<{
        token: string;
        platform: string;
      }>()
    ).results;

  it("registers the caller's device, and moves it to whoever signs in on it next", async () => {
    const put = (sub: string) =>
      api('/api/users/push-tokens', sub, { method: 'PUT', body: JSON.stringify({ token, platform: 'android' }) });

    expect((await put('auth0|p1')).status).toBe(204);
    expect(await tokensOf('auth0|p1')).toEqual([{ token, platform: 'android' }]);

    expect((await put('auth0|p2')).status).toBe(204);
    expect(await tokensOf('auth0|p1')).toEqual([]);
    expect(await tokensOf('auth0|p2')).toEqual([{ token, platform: 'android' }]);
  });

  it('notes a device whose app draws its own notices, and one that stops', async () => {
    const put = (body: object) =>
      api('/api/users/push-tokens', 'auth0|p5', { method: 'PUT', body: JSON.stringify({ token, platform: 'android', ...body }) });
    const drawsOwn = async () =>
      (await env.DB.prepare('SELECT draws_own FROM push_tokens WHERE token = ?1').bind(token).first<{ draws_own: number }>())
        ?.draws_own;

    expect((await put({ drawsOwn: true })).status).toBe(204);
    expect(await drawsOwn()).toBe(1);
    // An older version of the app, installed over it, doesn't say.
    expect((await put({})).status).toBe(204);
    expect(await drawsOwn()).toBe(0);
  });

  it("removes the caller's own device only", async () => {
    await api('/api/users/push-tokens', 'auth0|p3', { method: 'PUT', body: JSON.stringify({ token, platform: 'ios' }) });

    await api('/api/users/push-tokens', 'auth0|p4', { method: 'DELETE', body: JSON.stringify({ token }) });
    expect(await tokensOf('auth0|p3')).toHaveLength(1);

    const res = await api('/api/users/push-tokens', 'auth0|p3', { method: 'DELETE', body: JSON.stringify({ token }) });
    expect(res.status).toBe(204);
    expect(await tokensOf('auth0|p3')).toEqual([]);
  });

  it.each([
    ['a token that is not an Expo push token', { token: 'abc', platform: 'android' }],
    ['an unknown platform', { token, platform: 'web' }],
    ['a drawsOwn that is not true or false', { token, platform: 'android', drawsOwn: 'yes' }],
  ])('rejects %s with a 400', async (_, body) => {
    const res = await api('/api/users/push-tokens', 'auth0|p1', { method: 'PUT', body: JSON.stringify(body) });
    expect(res.status).toBe(400);
  });
});

describe('toPublicUser', () => {
  it('keeps only the id, display name and picture', () => {
    const u: Auth0User = {
      user_id: 'u1',
      email: 'e@example.com',
      name: 'Real Name',
      given_name: 'Real',
      family_name: 'Name',
      picture: 'raw.png',
      user_metadata: { displayName: 'Meta Name', theme: 'Dark' },
    };
    expect(toPublicUser(u)).toEqual({ user_id: 'u1', displayName: 'Meta Name', picture: 'raw.png' });
  });
});

describe('toUserResponse', () => {
  describe('picture', () => {
    it('prefers a non-blank user_metadata.picture over the raw top-level picture', () => {
      const u: Auth0User = { user_id: 'u1', picture: 'raw.png', user_metadata: { picture: 'meta.png' } };
      expect(toUserResponse(u).picture).toBe('meta.png');
    });

    it('falls back to the raw picture when user_metadata.picture is blank/whitespace', () => {
      const u: Auth0User = { user_id: 'u1', picture: 'raw.png', user_metadata: { picture: '   ' } };
      expect(toUserResponse(u).picture).toBe('raw.png');
    });

    it('falls back to the raw picture when user_metadata is absent entirely', () => {
      const u: Auth0User = { user_id: 'u1', picture: 'raw.png' };
      expect(toUserResponse(u).picture).toBe('raw.png');
    });
  });

  describe('highlightPlayable', () => {
    it('is off unless the player turned it on', () => {
      expect(toUserResponse({ user_id: 'u1' }).highlightPlayable).toBe(false);
      expect(toUserResponse({ user_id: 'u1', user_metadata: { highlightPlayable: false } }).highlightPlayable).toBe(false);
      expect(toUserResponse({ user_id: 'u1', user_metadata: { highlightPlayable: true } }).highlightPlayable).toBe(true);
    });

    it('is not shown to other players', () => {
      const u: Auth0User = { user_id: 'u1', user_metadata: { highlightPlayable: true } };
      expect(toPublicUser(u)).not.toHaveProperty('highlightPlayable');
    });
  });

  describe('pushNotifications', () => {
    it('is on unless the player turned it off', () => {
      expect(toUserResponse({ user_id: 'u1' }).pushNotifications).toBe(true);
      expect(toUserResponse({ user_id: 'u1', user_metadata: { pushNotifications: false } }).pushNotifications).toBe(false);
    });
  });

  describe('displayName', () => {
    it('prefers user_metadata.displayName over everything else', () => {
      const u: Auth0User = {
        user_id: 'u1',
        user_metadata: { displayName: 'Meta Name' },
        nickname: 'nick',
        name: 'Name',
        email: 'e@example.com',
      };
      expect(toUserResponse(u).displayName).toBe('Meta Name');
    });

    it('falls back to nickname when user_metadata.displayName is absent', () => {
      const u: Auth0User = { user_id: 'u1', nickname: 'nick', name: 'Name', email: 'e@example.com' };
      expect(toUserResponse(u).displayName).toBe('nick');
    });

    it('falls back to name when nickname is also absent', () => {
      const u: Auth0User = { user_id: 'u1', name: 'Name', email: 'e@example.com' };
      expect(toUserResponse(u).displayName).toBe('Name');
    });

    it('falls back to email when name is also absent', () => {
      const u: Auth0User = { user_id: 'u1', email: 'e@example.com' };
      expect(toUserResponse(u).displayName).toBe('e@example.com');
    });

    it('falls back to the literal "Unknown User ({id})" when everything else is absent', () => {
      const u: Auth0User = { user_id: 'u1' };
      expect(toUserResponse(u).displayName).toBe('Unknown User (u1)');
    });
  });
});
