// Leaving a Custom match after the deal, against the real MatchDO: the leaver's seat is parked with
// a bot that finishes the hand, then opens for a person; Fill with bots gives the open seat to the
// bot for good. Async matches still refuse, and a table with no other person seated is dropped.
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { Bid, Suit, Teams, createDomino, openPositions, type Domino, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import { syncLobbyIndex } from '../src/lobby';

const testEnv = env as unknown as Env;

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
