import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, fetchMock, runInDurableObject, SELF } from 'cloudflare:test';
import { Teams, type Positions, type MatchState } from '@fortytwo/rules';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import app, { type Env } from '../src/index';

const testEnv = env as unknown as Env;

// Must match the AUTH0_DOMAIN/AUTH0_AUDIENCE test-pool bindings configured in vitest.config.ts -
// the top-level app's `requireAuth()` (index.ts) has no injectable resolver, unlike
// verifyJwt.test.ts's own Hono instance, so it always resolves the real (here, mocked-via-
// fetchMock) remote JWKS - mirrors matchDOSocket.test.ts's setup.
const AUTH0_DOMAIN = 'test-tenant.auth0.local';
const AUTH0_AUDIENCE = 'https://api.test.local';
const ISSUER = `https://${AUTH0_DOMAIN}/`;
const KEY_ID = 'routes-matches-test-key';

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

// Wipes both lobby-index tables before each test, mirroring lobby.test.ts - D1's local storage
// persists across tests within a single vitest-pool-workers run. (Each test creates its own
// match with a fresh crypto.randomUUID() id, so DO storage itself never needs resetting.)
beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM match_players'),
    testEnv.DB.prepare('DELETE FROM matches'),
  ]);
});

describe('match routes', () => {
  it(
    'drives a full match lifecycle - create, join (dealing on the 4th join), ready up, bid, ' +
      'set trump, play a domino - and rejects a non-participant action with 400 + title',
    async () => {
      const p1 = await signToken('p1');
      const p2 = await signToken('p2');
      const p3 = await signToken('p3');
      const p4 = await signToken('p4');
      const outsider = await signToken('p5');

      // --- POST /api/matches: create ---
      const createRes = await api('/api/matches', p1, { method: 'POST' });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: string };
      const matchId = created.id;
      expect(matchId).toBeTruthy();

      // The id returned to the client must be the SAME id the D1 lobby-index row was written
      // under - `matchEngine.ts`'s `createMatch()` mints its own internal (unrelated) id, so the
      // response's `id` must be normalized to the route's own DO-addressing key, or a client
      // could never reach this match again via `GET /api/matches/:id`.
      const rowAfterCreate = await testEnv.DB.prepare('SELECT player_count FROM matches WHERE id = ?')
        .bind(matchId)
        .first<{ player_count: number }>();
      expect(rowAfterCreate?.player_count).toBe(1);

      // --- GET /api/matches?filter=Joinable from a second user's token ---
      const joinableRes = await api('/api/matches?filter=Joinable', p2);
      expect(joinableRes.status).toBe(200);
      const joinable = (await joinableRes.json()) as { id: string; teams: string[][] }[];
      expect(joinable.some((m) => m.id === matchId)).toBe(true);
      // No Auth0 mock here, so name lookup fails and players fall back to their raw ids rather
      // than failing the whole list.
      expect(joinable.find((m) => m.id === matchId)?.teams).toEqual([['p1'], []]);

      // --- POST /api/matches/:id/players: p2 joins (team 2 / TeamB) ---
      const join2 = await api(`/api/matches/${matchId}/players`, p2, {
        method: 'POST',
        body: JSON.stringify({ team: 2 }),
      });
      expect(join2.status).toBe(200);
      const rowAfterP2 = await testEnv.DB.prepare('SELECT player_count FROM matches WHERE id = ?')
        .bind(matchId)
        .first<{ player_count: number }>();
      expect(rowAfterP2?.player_count).toBe(2);

      // p3 joins (team 1 / TeamA, p1's team).
      const join3 = await api(`/api/matches/${matchId}/players`, p3, {
        method: 'POST',
        body: JSON.stringify({ team: 1 }),
      });
      expect(join3.status).toBe(200);

      // --- p4 joins: the 4th player. This join ITSELF must trigger the deal (Change 1) - no
      // ready-up has happened yet, proving dealing doesn't depend on the ready-up path. ---
      const join4 = await api(`/api/matches/${matchId}/players`, p4, {
        method: 'POST',
        body: JSON.stringify({ team: 2 }),
      });
      expect(join4.status).toBe(200);
      const afterJoin4 = (await join4.json()) as {
        currentGame: {
          hands: { playerId: string; dominoes: { id: string; top: number; bottom: number }[]; hiddenCount?: number }[];
        };
        players: { playerId: string }[];
      };
      expect(afterJoin4.players).toHaveLength(4);
      expect(afterJoin4.currentGame.hands).toHaveLength(4);
      // p4 sees their own 7 dominoes and only a count of everyone else's.
      for (const hand of afterJoin4.currentGame.hands) {
        if (hand.playerId !== 'p4') {
          expect(hand).toMatchObject({ dominoes: [], hiddenCount: 7 });
          continue;
        }
        expect(hand.dominoes).toHaveLength(7);
        for (const domino of hand.dominoes) {
          // Every dealt domino must have a genuine `.id`, not undefined - the deal is built with
          // createDomino(), not hand-rolled {top,bottom} objects.
          expect(domino.id).toBeTruthy();
          expect(typeof domino.id).toBe('string');
        }
      }

      const rowAfterP4 = await testEnv.DB.prepare('SELECT player_count FROM matches WHERE id = ?')
        .bind(matchId)
        .first<{ player_count: number }>();
      expect(rowAfterP4?.player_count).toBe(4);

      // --- GET /api/matches/:id must return FULL MatchState (Change 3), not the narrow
      // per-player shape: a `players` array with all 4 players, no top-level `playerId`. ---
      const fullRes = await api(`/api/matches/${matchId}`, p1);
      expect(fullRes.status).toBe(200);
      const full = (await fullRes.json()) as {
        players: { playerId: string }[];
        currentGame: unknown;
        games: unknown;
      };
      expect(full.players).toHaveLength(4);
      expect(full.players.map((p) => p.playerId).sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
      expect(full.currentGame).toBeDefined();
      expect(full.games).toBeDefined();
      expect(full).not.toHaveProperty('playerId');

      // --- GET /api/matches/:id/players (Change 4, previously missing) must return the NARROW
      // per-player DTO for the calling user, not the full match. ---
      const playerViewRes = await api(`/api/matches/${matchId}/players`, p1);
      expect(playerViewRes.status).toBe(200);
      const playerView = (await playerViewRes.json()) as Record<string, unknown>;
      expect(playerView.playerId).toBe('p1');
      expect(playerView).not.toHaveProperty('players');
      expect(playerView).not.toHaveProperty('currentGame');

      // --- PATCH /api/matches/:id/players: ready up all 4. The deal already happened on p4's
      // join, so this only flips ready flags (no second deal - no game has finished yet). ---
      for (const token of [p1, p2, p3, p4]) {
        const readyRes = await api(`/api/matches/${matchId}/players`, token, {
          method: 'PATCH',
          body: JSON.stringify({ ready: true }),
        });
        expect(readyRes.status).toBe(200);
      }

      // --- Bidding: p1 (currentPlayerId since createMatch/deal never changed it) bids 30;
      // p2/p3/p4 pass in seat order. ---
      const bid1 = await api(`/api/matches/${matchId}/games/current/bids`, p1, {
        method: 'POST',
        body: JSON.stringify({ bid: 30 }),
      });
      expect(bid1.status).toBe(200);

      for (const token of [p2, p3, p4]) {
        const passRes = await api(`/api/matches/${matchId}/games/current/bids`, token, {
          method: 'POST',
          body: JSON.stringify({ bid: 0 }),
        });
        expect(passRes.status).toBe(200);
      }

      // --- PATCH /api/matches/:id/games/current: p1 won the bid, sets trump. ---
      const trumpRes = await api(`/api/matches/${matchId}/games/current`, p1, {
        method: 'PATCH',
        body: JSON.stringify({ suit: 6 }),
      });
      expect(trumpRes.status).toBe(200);
      const afterTrump = (await trumpRes.json()) as {
        currentGame: {
          trump: number;
          hands: { playerId: string; dominoes: { id: string; top: number; bottom: number }[] }[];
        };
      };
      expect(afterTrump.currentGame.trump).toBe(6);

      // --- POST /api/matches/:id/games/current/moves: p1 plays their first domino (leading a
      // trick is always legal - no follow-suit constraint yet). ---
      const p1Hand = afterTrump.currentGame.hands.find((h) => h.playerId === 'p1')!;
      const domino = p1Hand.dominoes[0];
      const moveRes = await api(`/api/matches/${matchId}/games/current/moves`, p1, {
        method: 'POST',
        body: JSON.stringify({ domino }),
      });
      expect(moveRes.status).toBe(200);
      const afterMove = (await moveRes.json()) as { currentGame: { currentTrick: { dominoes: unknown[] } } };
      expect(afterMove.currentGame.currentTrick.dominoes.some((d) => d !== null)).toBe(true);

      // --- A non-participant's action returns 400 with a `title` - the outsider tries to join a
      // full (4-player) match. ---
      const outsiderJoin = await api(`/api/matches/${matchId}/players`, outsider, {
        method: 'POST',
        body: JSON.stringify({ team: 1 }),
      });
      expect(outsiderJoin.status).toBe(400);
      const outsiderJoinBody = (await outsiderJoin.json()) as { title: string };
      expect(outsiderJoinBody.title).toBeTruthy();
    }
  );

  it("returns the caller's own hand from GET /api/matches/:id and hides the rest", async () => {
    const tokens = await Promise.all(['p1', 'p2', 'p3', 'p4', 'p5'].map(signToken));
    const [p1, p2, p3, p4, outsider] = tokens;
    const created = (await (await api('/api/matches', p1, { method: 'POST' })).json()) as { id: string };
    for (const [token, position] of [[p2, 1], [p3, 2], [p4, 3]] as const) {
      await api(`/api/matches/${created.id}/players`, token, { method: 'POST', body: JSON.stringify({ position }) });
    }
    type View = { currentGame: { hands: { playerId: string; dominoes: unknown[]; hiddenCount?: number }[] } };

    const forP2 = (await (await api(`/api/matches/${created.id}`, p2)).json()) as View;
    const forOutsider = (await (await api(`/api/matches/${created.id}`, outsider)).json()) as View;

    for (const hand of forP2.currentGame.hands) {
      if (hand.playerId === 'p2') expect(hand.dominoes).toHaveLength(7);
      else expect(hand).toMatchObject({ dominoes: [], hiddenCount: 7 });
    }
    expect(forOutsider.currentGame.hands.every((h) => h.dominoes.length === 0 && h.hiddenCount === 7)).toBe(true);
  });

  it('lists each match with its teams by display name, falling back to the raw id', async () => {
    const p1 = await signToken('p1');
    const p2 = await signToken('p2');
    const p3 = await signToken('p3');
    const p4 = await signToken('p4');

    // p1 creates (TeamA), p2 joins TeamB, p3 joins TeamA.
    const created = (await (await api('/api/matches', p1, { method: 'POST' })).json()) as { id: string };
    await api(`/api/matches/${created.id}/players`, p2, { method: 'POST', body: JSON.stringify({ team: 2 }) });
    await api(`/api/matches/${created.id}/players`, p3, { method: 'POST', body: JSON.stringify({ team: 1 }) });

    // Auth0 knows p1 (with a user_metadata display name) but returns nothing for p2.
    const auth0 = fetchMock.get(`https://${AUTH0_DOMAIN}`);
    auth0
      .intercept({ path: '/oauth/token', method: 'POST' })
      .reply(200, JSON.stringify({ access_token: 'mgmt-token', expires_in: 3600, token_type: 'Bearer' }), {
        headers: { 'content-type': 'application/json' },
      });
    auth0
      .intercept({ path: (path: string) => path.startsWith('/api/v2/users?'), method: 'GET' })
      .reply(
        200,
        JSON.stringify([
          { user_id: 'p1', user_metadata: { displayName: 'Player One' } },
          { user_id: 'p3', nickname: 'three' },
        ]),
        { headers: { 'content-type': 'application/json' } }
      );

    const res = await api('/api/matches?filter=Joinable', p4);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; teams: string[][] }[];
    expect(rows.find((row) => row.id === created.id)?.teams).toEqual([['Player One', 'three'], ['p2']]);
  });

  it('joins at a picked seat and lists which seats are open', async () => {
    const p1 = await signToken('p1');
    const p2 = await signToken('p2');
    const p3 = await signToken('p3');

    const created = (await (await api('/api/matches', p1, { method: 'POST' })).json()) as { id: string };
    // p2 skips seat 1 (left of the creator) and sits at seat 3, on the creator's right.
    const join = await api(`/api/matches/${created.id}/players`, p2, { method: 'POST', body: JSON.stringify({ position: 3 }) });
    expect(join.status).toBe(200);
    const joined = (await join.json()) as { players: { playerId: string; position: number }[] };
    expect(joined.players.find((p) => p.playerId === 'p2')?.position).toBe(3);

    const taken = await api(`/api/matches/${created.id}/players`, p3, { method: 'POST', body: JSON.stringify({ position: 3 }) });
    expect(taken.status).toBe(400);
    expect(((await taken.json()) as { title: string }).title).toBe('Seat is taken');

    // No Auth0 mock, so seats show raw ids.
    const res = await api('/api/matches?filter=Joinable', p3);
    const rows = (await res.json()) as { id: string; seats: (string | null)[] }[];
    expect(rows.find((row) => row.id === created.id)?.seats).toEqual(['p1', null, null, 'p2']);
  });

  describe('malformed request bodies', () => {
    // Each is rejected at the route boundary, before the match is touched, with the same
    // { title, detail } shape the client renders for a rule violation.
    it.each([
      ['POST', 'players', undefined],
      ['POST', 'players', 'not json'],
      ['POST', 'players', '[]'],
      ['POST', 'players', '{}'],
      ['POST', 'players', '{"position":4}'],
      ['POST', 'players', '{"position":"1"}'],
      ['POST', 'players', '{"team":3}'],
      ['PATCH', 'players', '{}'],
      ['PATCH', 'players', '{"ready":"false"}'],
      ['PATCH', 'games/current', '{"suit":"6"}'],
      ['PATCH', 'games/current', '{"suit":8}'],
      ['POST', 'games/current/bids', '{"bid":"30"}'],
      ['POST', 'games/current/bids', '{"bid":29}'],
      ['POST', 'games/current/moves', '{"domino":null}'],
      ['POST', 'games/current/moves', '{"domino":{}}'],
      ['POST', 'games/current/moves', '{"domino":{"top":7,"bottom":0}}'],
      ['POST', 'games/current/moves', '{"domino":{"top":1.5,"bottom":0}}'],
    ])('%s %s with %s -> 400', async (method, path, body) => {
      const p1 = await signToken('p1');
      const created = (await (await api('/api/matches', p1, { method: 'POST' })).json()) as { id: string };

      const res = await api(`/api/matches/${created.id}/${path}`, p1, {
        method,
        body,
        headers: { 'content-type': 'application/json' },
      });

      expect(res.status).toBe(400);
      const error = (await res.json()) as { title: string; detail: string };
      expect(error.title).toBe('Invalid request');
      expect(error.detail).toEqual(expect.any(String));
    });

    it('hides unexpected errors behind a generic 500', async () => {
      const p1 = await signToken('p1');
      const broken = {
        ...testEnv,
        MATCH_DO: {
          idFromName: () => {
            throw new Error('secret internals');
          },
        },
      };

      const res = await app.request('/api/matches', { method: 'POST', headers: { Authorization: `Bearer ${p1}` } }, broken);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ title: 'Something went wrong' });
    });
  });

  describe('bots', () => {
    // SELF always runs with the pool's global bindings (AUTO_PLAY_BOTS: 'false'), so these call
    // the Hono app directly to switch the flag on for one request at a time.
    async function apiWithBots(path: string, token: string, init: RequestInit = {}, autoPlayBots = 'true') {
      return app.request(
        path,
        {
          ...init,
          headers: {
            ...(init.body ? { 'content-type': 'application/json' } : {}),
            Authorization: `Bearer ${token}`,
          },
        },
        { ...testEnv, AUTO_PLAY_BOTS: autoPlayBots }
      );
    }

    it('tells the client whether bots are available', async () => {
      const p1 = await signToken('p1');

      expect(await (await apiWithBots('/api/config', p1)).json()).toEqual({ bots: true });
      expect(await (await apiWithBots('/api/config', p1, {}, 'false')).json()).toEqual({ bots: false });
    });

    it('seats a bot at a picked seat, then fills the rest and syncs the lobby', async () => {
      const p1 = await signToken('p1');
      const created = (await (await api('/api/matches', p1, { method: 'POST' })).json()) as { id: string };

      const one = await apiWithBots(`/api/matches/${created.id}/bots`, p1, {
        method: 'POST',
        body: JSON.stringify({ position: 2 }),
      });
      expect(one.status).toBe(200);
      const afterOne = (await one.json()) as { players: { playerId: string; position: number }[] };
      expect(afterOne.players.find((p) => p.playerId === 'bot-1')?.position).toBe(2);

      const fill = await apiWithBots(`/api/matches/${created.id}/bots`, p1, { method: 'POST', body: '{}' });
      expect(fill.status).toBe(200);
      expect(((await fill.json()) as { players: unknown[] }).players).toHaveLength(4);

      const row = await testEnv.DB.prepare('SELECT player_count FROM matches WHERE id = ?')
        .bind(created.id)
        .first<{ player_count: number }>();
      expect(row?.player_count).toBe(4);
    });

    it('404s when bots are turned off', async () => {
      const p1 = await signToken('p1');
      const created = (await (await api('/api/matches', p1, { method: 'POST' })).json()) as { id: string };

      const res = await apiWithBots(`/api/matches/${created.id}/bots`, p1, { method: 'POST', body: '{}' }, 'false');

      expect(res.status).toBe(404);
    });

    it('rejects a seat that is not 0-3', async () => {
      const p1 = await signToken('p1');
      const created = (await (await api('/api/matches', p1, { method: 'POST' })).json()) as { id: string };

      const res = await apiWithBots(`/api/matches/${created.id}/bots`, p1, {
        method: 'POST',
        body: JSON.stringify({ position: 1.5 }),
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { title: string }).title).toBe('Invalid request');
    });

    it("won't let someone outside the match add bots", async () => {
      const p1 = await signToken('p1');
      const outsider = await signToken('p5');
      const created = (await (await api('/api/matches', p1, { method: 'POST' })).json()) as { id: string };

      const res = await apiWithBots(`/api/matches/${created.id}/bots`, outsider, { method: 'POST', body: '{}' });

      expect(res.status).toBe(400);
    });
  });

  it(
    "the WebSocket broadcast payload carries the SAME id as the REST create response - " +
      "createMatch() mints its own id, which MatchDO's `create` replaces with the id the DO is " +
      'addressed by',
    async () => {
      const p1 = await signToken('p1');
      const p2 = await signToken('p2');

      // Create via REST - this is the id a client would use to reach the match again.
      const createRes = await api('/api/matches', p1, { method: 'POST' });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: string };
      const restId = created.id;

      // Open a WebSocket DIRECTLY against the MatchDO stub for that same id - mirrors
      // matchDOSocket.test.ts's approach, since the id MatchDO broadcasts is what's under test
      // here, not routing (wsRoute.test.ts covers that).
      const stub = testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(restId));
      const upgradeRes = await stub.fetch(`https://match-do/ws?token=${p1}`, {
        headers: { Upgrade: 'websocket' },
      });
      expect(upgradeRes.status).toBe(101);
      const ws = upgradeRes.webSocket;
      if (!ws) throw new Error('expected a client WebSocket on the 101 response');
      ws.accept();

      try {
        const messagePromise = new Promise<MessageEvent>((resolve, reject) => {
          ws.addEventListener('message', (event) => resolve(event as MessageEvent), { once: true });
          ws.addEventListener('error', (event) => reject(event), { once: true });
        });

        // Trigger a broadcast-causing mutation through the REST layer, using the REST-returned id.
        const joinRes = await api(`/api/matches/${restId}/players`, p2, {
          method: 'POST',
          body: JSON.stringify({ team: 2 }),
        });
        expect(joinRes.status).toBe(200);

        const event = await messagePromise;
        const payload = JSON.parse(event.data as string) as { type: string; match: { id: string } };

        expect(payload.type).toBe('match');
        // Not the DIFFERENT, internally-minted id from createMatch().
        expect(payload.match.id).toBe(restId);
      } finally {
        ws.close();
      }
    }
  );
  it('collects rematch votes and hands every voter the rematch once all four agree', async () => {
    const tokens = await Promise.all(['p1', 'p2', 'p3', 'p4'].map(signToken));
    const matchId = crypto.randomUUID();
    const finished: MatchState = {
      id: matchId,
      createdOn: '2026-01-01T00:00:00.000Z',
      updatedOn: '2026-01-01T00:00:00.000Z',
      winningTeam: Teams.TeamB,
      games: {},
      players: ['p1', 'p2', 'p3', 'p4'].map((playerId, position) => ({
        playerId,
        position: position as Positions,
        ready: false,
      })),
      currentGame: {
        id: 'g9',
        name: 'Game 9',
        firstActionBy: 'p1',
        bid: null,
        biddingPlayerId: null,
        trump: null,
        currentPlayerId: 'p1',
        hands: ['p1', 'p2', 'p3', 'p4'].map((playerId, i) => ({
          playerId,
          team: i % 2 === 0 ? Teams.TeamA : Teams.TeamB,
          dominoes: [],
          bid: null,
        })),
        currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
        tricks: [],
      },
    };
    await runInDurableObject(testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(matchId)), async (_i, state) => {
      await state.storage.put('match', finished);
    });

    const stranger = await api(`/api/matches/${matchId}/rematch`, await signToken('stranger'), { method: 'POST' });
    expect(stranger.status).toBe(400);
    await stranger.json();

    let last: MatchState | undefined;
    for (const token of tokens) {
      const res = await api(`/api/matches/${matchId}/rematch`, token, { method: 'POST' });
      expect(res.status).toBe(200);
      last = await res.json();
    }

    expect(last!.rematchId).toBeTruthy();
    const rematch = await api(`/api/matches/${last!.rematchId}`, tokens[0]);
    expect(rematch.status).toBe(200);
    const body: MatchState = await rematch.json();
    expect(body.players).toHaveLength(4);
    // Still only the caller's own hand in full.
    expect(body.currentGame.hands.find((h) => h.playerId === 'p1')!.dominoes).toHaveLength(7);
    expect(body.currentGame.hands.find((h) => h.playerId === 'p2')!.dominoes).toHaveLength(0);
  });
});
