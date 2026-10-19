// The invite routes through the real Worker: inviting from a custom table, the Lobby's list, and cleanup.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { fetchMock } from './fetchMock';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import { syncLobbyIndex } from '../src/lobby';
import { saveUsers } from '../src/users/publicUsers';
import type { Env } from '../src/index';
import type { Invite, InviteResult } from '@fortytwo/api-types';
import { Bid, Suit, Teams, createDomino, type MatchState } from '@fortytwo/rules';

// Must match the AUTH0_DOMAIN/AUTH0_AUDIENCE test-pool bindings in vitest.config.ts, as in
// routes.matches.test.ts.
const AUTH0_DOMAIN = 'test-tenant.auth0.local';
const AUTH0_AUDIENCE = 'https://api.test.local';
const KEY_ID = 'routes-invites-test-key';

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

const testEnv = env as unknown as Env;
const ME = 'auth0|me';

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM invites'),
    testEnv.DB.prepare('DELETE FROM match_players'),
    testEnv.DB.prepare('DELETE FROM matches'),
    testEnv.DB.prepare('DELETE FROM users'),
    testEnv.DB.prepare('DELETE FROM push_tokens'),
  ]);
  await saveUsers(testEnv.DB, ['me', 'ann', 'bo', 'cy', 'di', 'eve', 'fay', 'gus', 'hal'].map((n) => ({ user_id: `auth0|${n}`, displayName: n })));
});

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

async function customTable(): Promise<MatchState> {
  return (await (await api('/api/matches', ME, { method: 'POST' })).json()) as MatchState;
}

async function sit(matchId: string, sub: string, position: number) {
  const res = await api(`/api/matches/${matchId}/players`, sub, json({ position }));
  expect(res.status).toBe(200);
}

async function invite(matchId: string, userIds: string[], sub = ME) {
  return api(`/api/matches/${matchId}/invites`, sub, json({ userIds }));
}

async function myInvites(sub: string): Promise<Invite[]> {
  return (await (await api('/api/invites', sub)).json()) as Invite[];
}

describe('POST /api/matches/:id/invites', () => {
  it('invites people, who then see it in their Lobby', async () => {
    const match = await customTable();
    const res = await invite(match.id, ['auth0|ann', 'auth0|bo']);
    expect(res.status).toBe(200);
    expect(((await res.json()) as InviteResult).invited).toEqual(['auth0|ann', 'auth0|bo']);
    expect(await myInvites('auth0|ann')).toEqual([
      { matchId: match.id, from: { user_id: ME, displayName: 'me' }, createdOn: expect.any(String), seatsOpen: 3 },
    ]);
  });

  it('skips seated players, bots, yourself and unknown ids', async () => {
    const match = await customTable();
    await sit(match.id, 'auth0|ann', 1);
    const res = await invite(match.id, ['auth0|ann', 'bot-1', ME, 'auth0|nobody', 'auth0|bo']);
    expect(((await res.json()) as InviteResult).invited).toEqual(['auth0|bo']);
  });

  it('invites each person once per table', async () => {
    const match = await customTable();
    await invite(match.id, ['auth0|ann']);
    expect(((await (await invite(match.id, ['auth0|ann'])).json()) as InviteResult).invited).toEqual([]);
  });

  it('stops at six invites a table', async () => {
    const match = await customTable();
    await invite(match.id, ['auth0|ann', 'auth0|bo', 'auth0|cy', 'auth0|di', 'auth0|eve']);
    const res = await invite(match.id, ['auth0|fay', 'auth0|gus']);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { title: string }).title).toBe('Too many invites');
    expect(((await (await invite(match.id, ['auth0|fay'])).json()) as InviteResult).invited).toEqual(['auth0|fay']);
  });

  it('refuses someone not at the table', async () => {
    const match = await customTable();
    expect((await invite(match.id, ['auth0|bo'], 'auth0|ann')).status).toBe(403);
  });

  it('refuses a table that is not a Custom Match', async () => {
    const res = await api('/api/matchmaking', ME, json({ mode: 'daily' }));
    expect(res.status).toBe(200);
    const match = (await res.json()) as MatchState;
    expect((await invite(match.id, ['auth0|ann'])).status).toBe(409);
  });

  it('refuses a body without user ids', async () => {
    const match = await customTable();
    expect((await api(`/api/matches/${match.id}/invites`, ME, json({ userIds: [] }))).status).toBe(400);
    expect((await api(`/api/matches/${match.id}/invites`, ME, json({}))).status).toBe(400);
  });
});

const stored = (stub: ReturnType<typeof testEnv.MATCH_DO.get>) =>
  runInDurableObject(stub, async (_instance, state) => state.storage.get<MatchState>('match'));

describe('invites at an open parked seat', () => {
  it('can be sent at the break, survive until someone sits, and list for the invitee', async () => {
    const match = await customTable();
    for (const [i, name] of ['ann', 'bo', 'cy'].entries()) await sit(match.id, `auth0|${name}`, i + 1);
    // The hand is decided, so ann leaving opens her seat at once.
    const stub = testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(match.id));
    await runInDurableObject(stub, async (_instance, state) => {
      const stored = (await state.storage.get<MatchState>('match'))!;
      const counts = [createDomino(5, 5), createDomino(6, 4), createDomino(5, 0), createDomino(4, 1)];
      await state.storage.put('match', {
        ...stored,
        currentGame: {
          ...stored.currentGame,
          biddingPlayerId: ME,
          bid: Bid.Thirty,
          trump: Suit.Sixes,
          currentPlayerId: null,
          tricks: [{ playerId: 'auth0|ann', team: Teams.TeamB, suit: Suit.Sixes, dominoes: counts }],
        },
      });
    });
    expect((await api(`/api/matches/${match.id}/players`, 'auth0|ann', { method: 'DELETE' })).status).toBe(200);

    const res = await invite(match.id, ['auth0|eve']);
    expect(res.status).toBe(200);
    expect(((await res.json()) as InviteResult).invited).toEqual(['auth0|eve']);
    expect(await myInvites('auth0|eve')).toEqual([
      { matchId: match.id, from: { user_id: ME, displayName: 'me' }, createdOn: expect.any(String), seatsOpen: 1 },
    ]);

    // A seat sync at the still-open table doesn't mistake it for full and wipe the invite.
    await syncLobbyIndex(testEnv.DB, (await stored(stub))!);
    expect(await myInvites('auth0|eve')).toHaveLength(1);

    await sit(match.id, 'auth0|eve', 1);
    expect(await myInvites('auth0|eve')).toEqual([]);
    const { n } = (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE match_id = ?').bind(match.id).first<{ n: number }>())!;
    expect(n).toBe(0);
  });
});

describe('invite cleanup', () => {
  it('clears invites when the invitee sits', async () => {
    const match = await customTable();
    await invite(match.id, ['auth0|ann', 'auth0|bo']);
    await sit(match.id, 'auth0|ann', 1);
    expect(await myInvites('auth0|ann')).toEqual([]);
    expect((await myInvites('auth0|bo'))[0].seatsOpen).toBe(2);
  });

  it('clears every invite when the table fills', async () => {
    const match = await customTable();
    await invite(match.id, ['auth0|eve']);
    await sit(match.id, 'auth0|ann', 1);
    await sit(match.id, 'auth0|bo', 2);
    await sit(match.id, 'auth0|cy', 3);
    expect(await myInvites('auth0|eve')).toEqual([]);
    const { n } = (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE match_id = ?').bind(match.id).first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it('clears invites when the match is deleted', async () => {
    const match = await customTable();
    await invite(match.id, ['auth0|ann']);
    // The creator leaving an empty table deletes it (204).
    expect((await api(`/api/matches/${match.id}/players`, ME, { method: 'DELETE' })).status).toBe(204);
    expect(await myInvites('auth0|ann')).toEqual([]);
    const { n } = (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE match_id = ?').bind(match.id).first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it('hides an invite to a table that has ended, even if cleanup missed it', async () => {
    const match = await customTable();
    await invite(match.id, ['auth0|ann']);
    await testEnv.DB.prepare("UPDATE matches SET status = 'completed' WHERE id = ?").bind(match.id).run();
    expect(await myInvites('auth0|ann')).toEqual([]);
  });

  it('dismisses an invite, and it is not sent again', async () => {
    const match = await customTable();
    await invite(match.id, ['auth0|ann']);
    expect((await api(`/api/invites/${match.id}`, 'auth0|ann', { method: 'DELETE' })).status).toBe(204);
    expect(await myInvites('auth0|ann')).toEqual([]);
    expect(((await (await invite(match.id, ['auth0|ann'])).json()) as InviteResult).invited).toEqual([]);
  });
});
