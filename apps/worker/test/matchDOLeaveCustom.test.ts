// Leaving a Custom match after the deal, against the real MatchDO: the leaver's seat is parked with
// a bot that finishes the hand, then opens for a person; Fill with bots gives the open seat to the
// bot for good. Async matches still refuse, and a table with no other person seated is dropped.
import { describe, it, expect, beforeAll } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import { fetchMock } from './fetchMock';
import { Bid, Suit, Teams, createDomino, openPositions, type Domino, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import { syncLobbyIndex } from '../src/lobby';

const testEnv = env as unknown as Env;

// Must match the AUTH0_DOMAIN/AUTH0_AUDIENCE test-pool bindings in vitest.config.ts, as in
// routes.matches.test.ts, so the moves and seat routes can be driven through the real Worker.
const AUTH0_DOMAIN = 'test-tenant.auth0.local';
const AUTH0_AUDIENCE = 'https://api.test.local';
const KEY_ID = 'leave-custom-test-key';

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
    .reply(200, JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } })
    .persist();
});

async function api(path: string, sub: string, init: RequestInit): Promise<Response> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setSubject(sub)
    .setIssuer(`https://${AUTH0_DOMAIN}/`)
    .setAudience(AUTH0_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  return SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
  });
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}
type Stub = ReturnType<typeof stubFor>;

async function stored(stub: Stub): Promise<MatchState> {
  return runInDurableObject(stub, async (_instance, state) => (await state.storage.get<MatchState>('match'))!);
}

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// Winds the stored hand to decided, as matchDOTakeover.test.ts does: seat 0 bid 30, and seat 1's
// team took one trick of 31 points, which sets it. Only the players in `ready` have readied up.
async function decideHand(stub: Stub, ready: (playerId: string) => boolean, extra: Partial<MatchState> = {}) {
  await runInDurableObject(stub, async (_instance, state) => {
    const match = (await state.storage.get<MatchState>('match'))!;
    const bidder = match.players.find((p) => p.position === 0)!.playerId;
    const setter = match.players.find((p) => p.position === 1)!.playerId;
    const counts = [createDomino(5, 5), createDomino(6, 4), createDomino(5, 0), createDomino(4, 1)];
    const decided: MatchState = {
      ...match,
      ...extra,
      currentGame: {
        ...match.currentGame,
        biddingPlayerId: bidder,
        bid: Bid.Thirty,
        trump: Suit.Sixes,
        currentPlayerId: null,
        tricks: [{ playerId: setter, team: Teams.TeamB, suit: Suit.Sixes, dominoes: counts }],
        ...extra.currentGame,
      },
      players: match.players.map((p) => ({ ...p, ready: ready(p.playerId) })),
    };
    await state.storage.put('match', decided);
    await state.storage.setAlarm(Date.now());
  });
}

// A dealt Custom match: p1 made it and p2-p4 sat down, the 4th seat dealing.
async function dealtCustom(name: string, mode: 'custom' | 'daily' = 'custom') {
  const stub = stubFor(name);
  await stub.create('p1', name, mode);
  for (const [i, id] of ['p2', 'p3', 'p4'].entries()) await stub.takeSeat(id, i + 1, deck());
  await syncLobbyIndex(testEnv.DB, await stored(stub));
  return stub;
}

// The deciding play of a hand, one play from the end: team B (seats 1 and 3) holds 11 points, and
// seat 3's 6-6 trumps seat 2's 3-3, so the last player's 4-1 adds a trick worth 6 to make 17, over
// the 12 that sets a bid of 30. `last` is the seat still to play; the others have played.
async function oneFromDecided(stub: Stub, last: 0 | 1) {
  await runInDurableObject(stub, async (_instance, state) => {
    const match = (await state.storage.get<MatchState>('match'))!;
    const at = (position: number) => match.players.find((p) => p.position === position)!.playerId;
    const played = [createDomino(1, 0), createDomino(2, 1), createDomino(3, 3), createDomino(6, 6)];
    await state.storage.put('match', {
      ...match,
      currentGame: {
        ...match.currentGame,
        biddingPlayerId: at(0),
        bid: Bid.Thirty,
        trump: Suit.Sixes,
        currentPlayerId: at(last),
        hands: match.currentGame.hands.map((h) => ({
          ...h,
          bid: h.playerId === at(0) ? Bid.Thirty : Bid.Pass,
          dominoes: h.playerId === at(last) ? [createDomino(4, 1)] : [],
        })),
        tricks: [{ playerId: at(3), team: Teams.TeamB, suit: Suit.Sixes, dominoes: [createDomino(5, 5)] }],
        currentTrick: {
          playerId: at(3),
          team: Teams.TeamB,
          suit: Suit.Threes,
          dominoes: played.map((d, position) => (position === last ? null : d)),
        },
      },
    });
  });
}

async function playerCount(name: string): Promise<number> {
  const row = await testEnv.DB.prepare('SELECT player_count FROM matches WHERE id = ?').bind(name).first<{ player_count: number }>();
  return row!.player_count;
}

describe('the lobby index and an open parked seat', () => {
  it('player_count drops to 3 when a human play decides the hand, and back to 4 on sit-down', async () => {
    const name = 'lc-lobby-human';
    const stub = await dealtCustom(name);
    expect((await stub.leave('p2')).ok).toBe(true);
    await oneFromDecided(stub, 0);
    expect(await playerCount(name)).toBe(4);

    const played = await api(`/api/matches/${name}/games/current/moves`, 'p1', json({ domino: createDomino(4, 1) }));
    expect(played.status).toBe(200);
    expect(openPositions(await stored(stub))).toEqual([1]);
    expect(await playerCount(name)).toBe(3);

    expect((await api(`/api/matches/${name}/players`, 'p5', json({ position: 1 }))).status).toBe(200);
    expect(await playerCount(name)).toBe(4);
  });

  it('player_count drops to 3 when a bot play decides the hand', async () => {
    const name = 'lc-lobby-bot';
    const stub = await dealtCustom(name);
    expect((await stub.leave('p2')).ok).toBe(true);
    await oneFromDecided(stub, 1);
    await runInDurableObject(stub, async (_i, state) => void (await state.storage.setAlarm(Date.now())));
    expect(await playerCount(name)).toBe(4);

    await runDurableObjectAlarm(stub);
    expect(openPositions(await stored(stub))).toEqual([1]);
    expect(await playerCount(name)).toBe(3);
  });
});

describe('leaving a Custom match after the deal', () => {
  it('parks the seat mid-hand; the bot finishes the hand and then waits unready', async () => {
    const stub = await dealtCustom('lc-park');
    const gameId = (await stored(stub)).currentGame.id;

    const left = await stub.leave('p2');
    expect(left.ok && !left.value.deleted).toBe(true);
    const parked = await stored(stub);
    const bot = parked.players.find((p) => p.position === 1)!.playerId;
    expect(bot).toMatch(/_bot-\d$/);
    expect(parked.parked).toEqual([bot]);
    expect(parked.replaced ?? []).toEqual([]);

    // Make it the bot's turn to bid: the alarm has it act.
    await runInDurableObject(stub, async (_i, state) => {
      const match = (await state.storage.get<MatchState>('match'))!;
      await state.storage.put('match', { ...match, currentGame: { ...match.currentGame, currentPlayerId: bot } });
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);
    const bid = (await stored(stub)).currentGame.hands.find((h) => h.playerId === bot)!.bid;
    expect(bid).not.toBeNull();

    // Once the hand is decided the others are ready, and the bot stays put instead of readying.
    await decideHand(stub, (id) => id !== bot);
    await runDurableObjectAlarm(stub);
    const after = await stored(stub);
    expect(after.players.find((p) => p.playerId === bot)!.ready).toBe(false);
    expect(after.currentGame.id).toBe(gameId);
  });

  it('drops the match when no other human is seated, even if they are offline', async () => {
    const stub = stubFor('lc-drop');
    await stub.create('p1', 'lc-drop', 'custom');
    await stub.addBots('p1');
    const left = await stub.leave('p1');
    expect(left.ok && left.value.deleted).toBe(true);
    expect((await stub.getMatch()).ok).toBe(false);
  });

  it('keeps the match when the others are seated but not connected', async () => {
    const stub = await dealtCustom('lc-offline');
    const left = await stub.leave('p2');
    expect(left.ok && !left.value.deleted).toBe(true);
    expect((await stub.getMatch()).ok).toBe(true);
  });

  it('opens the seat at once when the hand is already decided', async () => {
    const stub = await dealtCustom('lc-decided');
    await decideHand(stub, () => true);
    expect((await stub.leave('p2')).ok).toBe(true);
    expect(openPositions(await stored(stub))).toEqual([1]);
  });

  it('still refuses an Async match after the deal', async () => {
    const stub = await dealtCustom('lc-daily', 'daily');
    const left = await stub.leave('p2');
    expect(left.ok).toBe(false);
    expect(!left.ok && left.status).toBe(400);
  });

  it('Fill with bots unparks the open seat and the next hand deals', async () => {
    const stub = await dealtCustom('lc-fill');
    await decideHand(stub, (id) => id !== 'p2');
    expect((await stub.leave('p2')).ok).toBe(true);
    const gameId = (await stored(stub)).currentGame.id;
    expect(openPositions(await stored(stub))).toEqual([1]);

    expect((await stub.addBots('p1')).ok).toBe(true);
    expect((await stored(stub)).parked ?? []).toEqual([]);

    // The bot is no longer parked, so its ready-up in the alarm deals the next hand.
    for (let i = 0; i < 5 && (await stored(stub)).currentGame.id === gameId; i++) await runDurableObjectAlarm(stub);
    expect((await stored(stub)).currentGame.id).not.toBe(gameId);
  });
});
