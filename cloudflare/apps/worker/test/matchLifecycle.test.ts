// Task 16: full-lifecycle integration test exercising everything built in Tasks 9-15 together -
// auth, MatchDO, D1 lobby sync, and every match route - through the REAL Worker (SELF.fetch), with
// no mocking of internal layers. The only mocked boundary is the external Auth0 JWKS fetch, via
// `fetchMock`, mirroring the pattern established in routes.matches.test.ts/auth0Management.test.ts.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, fetchMock, SELF } from 'cloudflare:test';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import type { Env } from '../src/index';
import { Bid, Suit, isOfSuit, type Domino } from '@fortytwo/rules';

const testEnv = env as unknown as Env;

// Must match the AUTH0_DOMAIN/AUTH0_AUDIENCE test-pool bindings configured in vitest.config.ts.
const AUTH0_DOMAIN = 'test-tenant.auth0.local';
const AUTH0_AUDIENCE = 'https://api.test.local';
const ISSUER = `https://${AUTH0_DOMAIN}/`;
const KEY_ID = 'match-lifecycle-test-key';

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

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM match_players'),
    testEnv.DB.prepare('DELETE FROM matches'),
  ]);
});

interface HandDto {
  playerId: string;
  dominoes: Domino[];
  bid: Bid | null;
}

interface TrickDto {
  playerId: string | null;
  team: number | null;
  suit: Suit | null;
  dominoes: (Domino | null)[];
}

interface GameDto {
  currentPlayerId: string | null;
  biddingPlayerId: string | null;
  bid: Bid | null;
  trump: Suit | null;
  hands: HandDto[];
  currentTrick: TrickDto;
  tricks: TrickDto[];
}

interface MatchStateDto {
  id: string;
  currentGame: GameDto;
  players: { playerId: string; position: number }[];
  winningTeam: number | null;
}

// Mirrors the real follow-suit rule enforced server-side by `assertValidDomino`
// (packages/rules/src/validation.ts): must follow the led suit if able, else any domino is legal.
// When leading a trick (`ledSuit === null`), any domino is legal.
function pickLegalDomino(hand: Domino[], ledSuit: Suit | null, trump: Suit): Domino {
  if (ledSuit === null) return hand[0];
  const followers = hand.filter((d) => isOfSuit(d, ledSuit, trump));
  return followers.length > 0 ? followers[0] : hand[0];
}

async function d1Row(matchId: string): Promise<{ status: string; playerCount: number } | null> {
  return testEnv.DB.prepare('SELECT status, player_count AS playerCount FROM matches WHERE id = ?')
    .bind(matchId)
    .first<{ status: string; playerCount: number }>();
}

describe('match lifecycle', () => {
  it(
    'drives a full match through create, join (dealing on the 4th join), ready-up, bidding, ' +
      'setting trump, and playing 2 full tricks (8 plays) - all through the real Worker',
    async () => {
      const subs = ['lc-p1', 'lc-p2', 'lc-p3', 'lc-p4'];
      const [t1, t2, t3, t4] = await Promise.all(subs.map(signToken));
      const tokenByPlayerId: Record<string, string> = {
        [subs[0]]: t1,
        [subs[1]]: t2,
        [subs[2]]: t3,
        [subs[3]]: t4,
      };

      // --- Create as p1 ---
      const createRes = await api('/api/matches', t1, { method: 'POST' });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as MatchStateDto;
      const matchId = created.id;
      expect(matchId).toBeTruthy();

      // --- Join p2 (TeamB), p3 (TeamA), p4 (TeamB, 4th join triggers the deal) ---
      const join2 = await api(`/api/matches/${matchId}/players`, t2, {
        method: 'POST',
        body: JSON.stringify({ team: 2 }),
      });
      expect(join2.status).toBe(200);

      const join3 = await api(`/api/matches/${matchId}/players`, t3, {
        method: 'POST',
        body: JSON.stringify({ team: 1 }),
      });
      expect(join3.status).toBe(200);

      const join4 = await api(`/api/matches/${matchId}/players`, t4, {
        method: 'POST',
        body: JSON.stringify({ team: 2 }),
      });
      expect(join4.status).toBe(200);
      let state = (await join4.json()) as MatchStateDto;

      expect(state.players).toHaveLength(4);
      expect(state.currentGame.hands).toHaveLength(4);
      for (const hand of state.currentGame.hands) {
        expect(hand.dominoes).toHaveLength(7);
        for (const domino of hand.dominoes) {
          expect(domino.id).toBeTruthy();
          expect(typeof domino.id).toBe('string');
        }
      }

      // --- D1 lobby-index check #1: right after the 4th join ---
      const rowAfterJoin4 = await d1Row(matchId);
      expect(rowAfterJoin4?.status).toBe('active');
      expect(rowAfterJoin4?.playerCount).toBe(4);

      // --- Ready up all 4. For this match's FIRST hand this can't (and shouldn't) trigger a
      // second deal: patchPlayerReady only re-deals when the previous game already has a winner,
      // which is impossible before any bid has happened. Hands must stay exactly as dealt. ---
      const handsBeforeReady = state.currentGame.hands;
      for (const sub of subs) {
        const readyRes = await api(`/api/matches/${matchId}/players`, tokenByPlayerId[sub], {
          method: 'PATCH',
          body: JSON.stringify({ ready: true }),
        });
        expect(readyRes.status).toBe(200);
        state = (await readyRes.json()) as MatchStateDto;
      }
      for (const hand of state.currentGame.hands) {
        const before = handsBeforeReady.find((h) => h.playerId === hand.playerId)!;
        expect(hand.dominoes.map((d) => d.id)).toEqual(before.dominoes.map((d) => d.id));
      }

      // --- Bidding: whichever player is currentPlayerId bids Bid.Thirty (the lowest legal bid -
      // legal for anyone on the very first bid of a fresh match, since bid validation only checks
      // ordering, not hand strength). The other 3 pass, in the ACTUAL turn order reported by each
      // response, not an assumed seat order. ---
      const firstBidder = state.currentGame.currentPlayerId!;
      let currentPlayerId = firstBidder;
      for (let i = 0; i < 4; i++) {
        const token = tokenByPlayerId[currentPlayerId];
        const bidValue = i === 0 ? Bid.Thirty : Bid.Pass;
        const bidRes = await api(`/api/matches/${matchId}/games/current/bids`, token, {
          method: 'POST',
          body: JSON.stringify({ bid: bidValue }),
        });
        expect(bidRes.status).toBe(200);
        state = (await bidRes.json()) as MatchStateDto;
        currentPlayerId = state.currentGame.currentPlayerId!;
      }
      expect(state.currentGame.biddingPlayerId).toBe(firstBidder);
      expect(state.currentGame.bid).toBe(Bid.Thirty);
      // Bidding complete: currentPlayerId reverts to the winning bidder, who leads the first trick.
      expect(currentPlayerId).toBe(firstBidder);

      // --- Set trump: the winning bidder sets a normal (non-Low) suit, keeping turn order at a
      // simple 4-plays-per-trick cadence. ---
      const trumpRes = await api(`/api/matches/${matchId}/games/current`, tokenByPlayerId[firstBidder], {
        method: 'PATCH',
        body: JSON.stringify({ suit: Suit.Sixes }),
      });
      expect(trumpRes.status).toBe(200);
      state = (await trumpRes.json()) as MatchStateDto;
      expect(state.currentGame.trump).toBe(Suit.Sixes);

      // --- Play through 2 full tricks (8 plays), picking a legal domino each time and reading
      // whose turn it is from each response. ---
      for (let play = 0; play < 8; play++) {
        const playerId = state.currentGame.currentPlayerId!;
        const token = tokenByPlayerId[playerId];
        const hand = state.currentGame.hands.find((h) => h.playerId === playerId)!.dominoes;
        const ledSuit = state.currentGame.currentTrick.suit;
        const trump = state.currentGame.trump!;
        const domino = pickLegalDomino(hand, ledSuit, trump);

        const moveRes = await api(`/api/matches/${matchId}/games/current/moves`, token, {
          method: 'POST',
          body: JSON.stringify({ domino }),
        });
        expect(moveRes.status).toBe(200);
        state = (await moveRes.json()) as MatchStateDto;

        if ((play + 1) % 4 === 0) {
          // A trick just completed: filed to `tricks`, and `currentTrick` reset to empty.
          expect(state.currentGame.tricks).toHaveLength((play + 1) / 4);
          expect(state.currentGame.currentTrick.dominoes.every((d) => d === null)).toBe(true);

          // --- D1 lobby-index check at additional points mid-flow (after trick 1 and trick 2) ---
          const row = await d1Row(matchId);
          expect(row?.status).toBe('active');
          expect(row?.playerCount).toBe(4);
        }
      }

      expect(state.currentGame.tricks).toHaveLength(2);
      expect(state.winningTeam).toBeNull();
    }
  );
});
