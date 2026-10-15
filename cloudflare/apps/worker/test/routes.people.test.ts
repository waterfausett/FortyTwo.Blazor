// The /api/people routes through the real Worker: the list, name search and starring friends.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { fetchMock } from './fetchMock';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import { saveUsers } from '../src/users/publicUsers';
import type { Env } from '../src/index';
import type { Person } from '@fortytwo/api-types';

// Must match the AUTH0_DOMAIN/AUTH0_AUDIENCE test-pool bindings in vitest.config.ts, as in
// routes.matches.test.ts.
const AUTH0_DOMAIN = 'test-tenant.auth0.local';
const AUTH0_AUDIENCE = 'https://api.test.local';
const KEY_ID = 'routes-people-test-key';

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

const testEnv = env as unknown as Env; // import type { Env } from '../src/index'

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM played_with'),
    testEnv.DB.prepare('DELETE FROM friends'),
    testEnv.DB.prepare('DELETE FROM users'),
  ]);
  await saveUsers(testEnv.DB, [
    { user_id: 'auth0|me', displayName: 'Me' },
    { user_id: 'auth0|ann', displayName: 'Ann' },
    { user_id: 'auth0|anna', displayName: 'ANNA' },
    { user_id: 'auth0|bo', displayName: 'Bo' },
    { user_id: 'auth0|pct', displayName: '100% Cy' },
  ]);
});

async function played(other: string, on: string, games = 1) {
  await testEnv.DB.prepare('INSERT INTO played_with (user_id, other_id, last_played_on, games) VALUES (?, ?, ?, ?)')
    .bind('auth0|me', other, on, games)
    .run();
}

const names = (people: Person[]) => people.map((p) => p.displayName);

describe('GET /api/people', () => {
  it('lists friends first, without repeating them as recent', async () => {
    await played('auth0|ann', '2026-10-01T00:00:00.000Z', 3);
    await played('auth0|bo', '2026-10-02T00:00:00.000Z');
    expect((await api('/api/people/friends/auth0%7Cann', 'auth0|me', { method: 'PUT' })).status).toBe(204);

    const people = (await (await api('/api/people', 'auth0|me')).json()) as Person[];
    expect(people).toEqual([
      { user_id: 'auth0|ann', displayName: 'Ann', isFriend: true, lastPlayedOn: '2026-10-01T00:00:00.000Z', games: 3 },
      { user_id: 'auth0|bo', displayName: 'Bo', isFriend: false, lastPlayedOn: '2026-10-02T00:00:00.000Z', games: 1 },
    ]);
  });

  it('lists recent players newest first', async () => {
    await played('auth0|ann', '2026-10-01T00:00:00.000Z');
    await played('auth0|bo', '2026-10-02T00:00:00.000Z');
    expect(names((await (await api('/api/people', 'auth0|me')).json()) as Person[])).toEqual(['Bo', 'Ann']);
  });

  it('is empty for someone new', async () => {
    expect(await (await api('/api/people', 'auth0|me')).json()).toEqual([]);
  });
});

describe('GET /api/people/search', () => {
  it('search is a case-insensitive prefix, with no wildcards', async () => {
    const found = async (q: string) =>
      names((await (await api(`/api/people/search?q=${encodeURIComponent(q)}`, 'auth0|me')).json()) as Person[]);
    expect(await found('an')).toEqual(['Ann', 'ANNA']);
    expect(await found('  ANN ')).toEqual(['Ann', 'ANNA']);
    expect(await found('%%')).toEqual([]);
    expect(await found('10')).toEqual(['100% Cy']);
  });

  it('leaves the caller out and marks friends', async () => {
    await api('/api/people/friends/auth0%7Cbo', 'auth0|me', { method: 'PUT' });
    const people = (await (await api('/api/people/search?q=Bo', 'auth0|me')).json()) as Person[];
    expect(people).toEqual([{ user_id: 'auth0|bo', displayName: 'Bo', isFriend: true, lastPlayedOn: null, games: 0 }]);
    expect(names((await (await api('/api/people/search?q=Me', 'auth0|me')).json()) as Person[])).toEqual([]);
  });

  it('refuses a query that is too short or too long', async () => {
    expect((await api('/api/people/search?q=a', 'auth0|me')).status).toBe(400);
    expect((await api('/api/people/search', 'auth0|me')).status).toBe(400);
    expect((await api(`/api/people/search?q=${'x'.repeat(41)}`, 'auth0|me')).status).toBe(400);
  });
});

describe('friends', () => {
  it('stars and unstars, idempotently', async () => {
    for (let i = 0; i < 2; i++) expect((await api('/api/people/friends/auth0%7Cbo', 'auth0|me', { method: 'PUT' })).status).toBe(204);
    expect((await (await api('/api/people', 'auth0|me')).json()) as Person[]).toHaveLength(1);
    for (let i = 0; i < 2; i++) expect((await api('/api/people/friends/auth0%7Cbo', 'auth0|me', { method: 'DELETE' })).status).toBe(204);
    expect(await (await api('/api/people', 'auth0|me')).json()).toEqual([]);
  });

  it('refuses yourself, a bot, and someone it has never seen', async () => {
    expect((await api('/api/people/friends/auth0%7Cme', 'auth0|me', { method: 'PUT' })).status).toBe(400);
    expect((await api('/api/people/friends/bot-1', 'auth0|me', { method: 'PUT' })).status).toBe(400);
    expect((await api('/api/people/friends/auth0%7Cnobody', 'auth0|me', { method: 'PUT' })).status).toBe(404);
  });

  it("doesn't tell the other person", async () => {
    await api('/api/people/friends/auth0%7Cbo', 'auth0|me', { method: 'PUT' });
    expect(await (await api('/api/people', 'auth0|bo')).json()).toEqual([]);
  });
});
