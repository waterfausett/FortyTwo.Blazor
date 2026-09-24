import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, fetchMock, SELF } from 'cloudflare:test';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import type { Env } from '../src/index';

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
      const joinable = (await joinableRes.json()) as { id: string }[];
      expect(joinable.some((m) => m.id === matchId)).toBe(true);

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
        currentGame: { hands: { playerId: string; dominoes: { id: string; top: number; bottom: number }[] }[] };
        players: { playerId: string }[];
      };
      expect(afterJoin4.players).toHaveLength(4);
      expect(afterJoin4.currentGame.hands).toHaveLength(4);
      for (const hand of afterJoin4.currentGame.hands) {
        expect(hand.dominoes).toHaveLength(7);
        for (const domino of hand.dominoes) {
          // Change 2: every dealt domino must have a genuine `.id`, not undefined - proves
          // shuffledDominoOrder() uses createDomino() rather than hand-rolled {top,bottom} objects.
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
});
