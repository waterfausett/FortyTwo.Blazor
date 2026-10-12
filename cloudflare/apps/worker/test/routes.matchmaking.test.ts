import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { fetchMock } from './fetchMock';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import { app, type Env } from '../src/index';
import { syncLobbyIndex } from '../src/lobby';
import { createDomino, type Domino } from '@fortytwo/rules';

const testEnv = env as unknown as Env;

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// Must match the AUTH0_DOMAIN/AUTH0_AUDIENCE test-pool bindings configured in vitest.config.ts -
// the top-level app's `requireAuth()` (index.ts) has no injectable resolver, unlike
// verifyJwt.test.ts's own Hono instance, so it always resolves the real (here, mocked-via-
// fetchMock) remote JWKS - mirrors matchDOSocket.test.ts's setup.
const AUTH0_DOMAIN = 'test-tenant.auth0.local';
const AUTH0_AUDIENCE = 'https://api.test.local';
const ISSUER = `https://${AUTH0_DOMAIN}/`;
const KEY_ID = 'routes-matchmaking-test-key';

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
  fetchMock
    .get(`https://${AUTH0_DOMAIN}`)
    .intercept({ path: '/.well-known/jwks.json', method: 'GET' })
    .reply(200, JSON.stringify({ keys: [publicJwk] }), {
      headers: { 'content-type': 'application/json' },
    })
    .persist();
});

async function signToken(sub: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUTH0_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

// Always drives requests through the real Worker (SELF, from cloudflare:test) - so this exercises
// the full stack: requireAuth middleware, Hono routing, MatchDO RPC calls, and D1 lobby sync -
// not just routes/matches.ts in isolation.
async function api(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

// SELF always runs with the pool's global bindings (BOTS_ENABLED: 'false'), so this calls the Hono
// app directly to switch the flag on for one request.
async function apiWithBots(path: string, token: string, init: RequestInit = {}, botsEnabled = 'true') {
  return app.request(
    path,
    {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
      },
    },
    { ...testEnv, BOTS_ENABLED: botsEnabled }
  );
}

describe('POST /api/matchmaking', () => {
  it('seats two Daily players at one table and lists it in Active as filling', async () => {
    const [a, b] = await Promise.all(['mm-a', 'mm-b'].map(signToken));
    const first = (await (await api('/api/matchmaking', a, { method: 'POST', body: JSON.stringify({ mode: 'daily' }) })).json()) as { id: string };
    const second = (await (await api('/api/matchmaking', b, { method: 'POST', body: JSON.stringify({ mode: 'daily' }) })).json()) as { id: string; players: unknown[] };

    expect(second.id).toBe(first.id);
    expect(second.players).toHaveLength(2);
    const listed = (await (await api('/api/matches?filter=Active', a)).json()) as { matches: { id: string; mode: string; turn: unknown }[] };
    expect(listed.matches).toEqual([expect.objectContaining({ id: first.id, mode: 'daily', turn: null })]);
  });

  it('refuses Live while bots are switched off', async () => {
    const res = await api('/api/matchmaking', await signToken('mm-c'), { method: 'POST', body: JSON.stringify({ mode: 'live' }) });
    expect(res.status).toBe(404);
    await res.text();
  });

  it('starts a Live search when bots are on, kept out of Active until it is dealt', async () => {
    const token = await signToken('mm-d');
    const res = await apiWithBots('/api/matchmaking', token, { method: 'POST', body: JSON.stringify({ mode: 'live' }) });
    expect(res.status).toBe(200);
    await res.text();
    const listed = (await (await api('/api/matches?filter=Active', token)).json()) as { matches: unknown[] };
    expect(listed.matches).toEqual([]);
  });

  it('takes a player already in a Live game back to it rather than starting another', async () => {
    const matchId = `live-under-way-${crypto.randomUUID()}`;
    const stub = testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(matchId));
    await stub.create('lv-1', matchId, 'live');
    await stub.takeSeat('lv-2', 1);
    await stub.takeSeat('lv-3', 2);
    const dealt = await stub.takeSeat('lv-4', 3, deck());
    if (!dealt.ok) throw new Error('expected the fourth seat to deal');
    await syncLobbyIndex(testEnv.DB, dealt.value);

    const res = await apiWithBots('/api/matchmaking', await signToken('lv-1'), { method: 'POST', body: JSON.stringify({ mode: 'live' }) });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(matchId);
  });

  it('rejects an unknown mode', async () => {
    const res = await api('/api/matchmaking', await signToken('mm-e'), { method: 'POST', body: JSON.stringify({ mode: 'blitz' }) });
    expect(res.status).toBe(400);
    await res.text();
  });
});

describe('GET /presence/ws', () => {
  it("isn't there while PRESENCE_ENABLED is unset", async () => {
    const res = await SELF.fetch('https://example.com/presence/ws', { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(404);
    await res.text();
  });

  it('wants a WebSocket upgrade once presence is on', async () => {
    const res = await app.request('/presence/ws', {}, { ...testEnv, PRESENCE_ENABLED: 'true' });
    expect(res.status).toBe(426);
    await res.text();
  });
});

describe('GET /api/config', () => {
  it('reports presence off unless PRESENCE_ENABLED is exactly "true"', async () => {
    const token = await signToken('cfg-1');
    const config = async (PRESENCE_ENABLED?: string) => {
      const res = await app.request('/api/config', { headers: { Authorization: `Bearer ${token}` } }, { ...testEnv, PRESENCE_ENABLED });
      return ((await res.json()) as { presence: boolean }).presence;
    };
    expect(await config()).toBe(false);
    expect(await config('yes')).toBe(false);
    expect(await config('true')).toBe(true);
  });
});

describe('Active turn status', () => {
  it("says it's your turn on a dealt match", async () => {
    const tokens = await Promise.all(['t1', 't2', 't3', 't4'].map(signToken));
    const created = (await (await api('/api/matches', tokens[0], { method: 'POST' })).json()) as { id: string };
    for (const [token, position] of [[tokens[1], 1], [tokens[2], 2], [tokens[3], 3]] as const) {
      await (await api(`/api/matches/${created.id}/players`, token, { method: 'POST', body: JSON.stringify({ position }) })).arrayBuffer();
    }
    const match = (await (await api(`/api/matches/${created.id}`, tokens[0])).json()) as { currentGame: { currentPlayerId: string } };
    const turnToken = tokens[['t1', 't2', 't3', 't4'].indexOf(match.currentGame.currentPlayerId)];

    const listed = (await (await api('/api/matches?filter=Active', turnToken)).json()) as { matches: { turn: { kind: string; yours: boolean } }[] };

    expect(listed.matches[0].turn).toMatchObject({ kind: 'turn', yours: true });
  });
});

describe('PATCH /api/matches/:id/players { autopilot: false }', () => {
  it("refuses someone who isn't at the table", async () => {
    const owner = await signToken('ap-1');
    const created = (await (await api('/api/matches', owner, { method: 'POST' })).json()) as { id: string };
    const res = await api(`/api/matches/${created.id}/players`, await signToken('ap-2'), { method: 'PATCH', body: JSON.stringify({ autopilot: false }) });
    expect(res.status).toBe(400);
    await res.text();
  });

  it('answers a seated player with the match', async () => {
    const owner = await signToken('ap-3');
    const created = (await (await api('/api/matches', owner, { method: 'POST' })).json()) as { id: string };
    const res = await api(`/api/matches/${created.id}/players`, owner, { method: 'PATCH', body: JSON.stringify({ autopilot: false }) });
    expect(res.status).toBe(200);
    await res.text();
  });
});
