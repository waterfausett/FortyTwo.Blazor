// Exercises the dev-only bots end to end against the real MatchDO: seating bots on demand (one
// seat, or every open seat), then the alarm-paced bot loop carrying bidding/trump/play forward up
// to a human's next turn. AUTO_PLAY_BOTS only gates the REST route that seats bots, so these tests
// can call MatchDO directly without it.
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { Bid, Suit, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import { syncLobbyIndex } from '../src/lobby';
import { countLobbyWrites } from './lobbyWrites';

const testEnv = env as unknown as Env;

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}

// The value of a result that must have succeeded.
function valueOf<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error(`expected an ok result, got ${JSON.stringify(result)}`);
  return result.value;
}

async function runAllPendingAlarms(stub: ReturnType<typeof stubFor>, maxTicks = 20): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    const ran = await runDurableObjectAlarm(stub);
    if (!ran) return;
  }
  throw new Error('too many bot alarm ticks - possible infinite loop');
}

function seatOf(match: MatchState, playerId: string): number | undefined {
  return match.players.find((p) => p.playerId === playerId)?.position;
}

describe('MatchDO bot auto-play', () => {
  it('seats a bot at a picked seat', async () => {
    const stub = stubFor('bots-one-seat');
    await stub.create('human-1', 'bots-one-seat');

    const match = valueOf(await stub.addBots('human-1', [2]));

    expect(match.players).toHaveLength(2);
    expect(seatOf(match, 'bot-1')).toBe(2);
  });

  it('fills every open seat around the humans when no seat is given, dealing the hand', async () => {
    const stub = stubFor('bots-fill');
    await stub.create('human-1', 'bots-fill');
    await stub.takeSeat('human-2', 2);
    await stub.addBots('human-1', [1]);

    const match = valueOf(await stub.addBots('human-2'));

    expect(match.players.map((p) => [p.playerId, p.position]).sort()).toEqual([
      ['bot-1', 1],
      ['bot-2', 3],
      ['human-1', 0],
      ['human-2', 2],
    ]);
    expect(match.currentGame.hands.every((h) => h.dominoes.length === 7)).toBe(true);
  });

  it("won't let someone outside the match add bots", async () => {
    const stub = stubFor('bots-outsider');
    await stub.create('human-1', 'bots-outsider');

    expect(await stub.addBots('stranger')).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects a bot at a taken seat', async () => {
    const stub = stubFor('bots-taken-seat');
    await stub.create('human-1', 'bots-taken-seat');

    const result = await stub.addBots('human-1', [0]);

    expect(result).toMatchObject({ ok: false, status: 400, error: { title: 'Seat is taken' } });
  });

  it("bots auto-bid, auto-set-trump, and auto-play up to the human's next turn", async () => {
    const stub = stubFor('bots-bid-and-play');

    await stub.create('human-1', 'bots-bid-and-play');
    let match = valueOf(await stub.addBots('human-1'));
    expect(match.currentGame.currentPlayerId).toBe('human-1');

    // Human bids the minimum; bots always pass, so human wins the bid outright.
    match = valueOf(await stub.bid('human-1', Bid.Thirty));
    expect(match.currentGame.hands.some((h) => h.bid === null)).toBe(true); // bots haven't acted yet

    await runAllPendingAlarms(stub);

    match = valueOf(await stub.getMatch());
    expect(match.currentGame.hands.every((h) => h.bid !== null)).toBe(true);
    expect(match.currentGame.biddingPlayerId).toBe('human-1');
    expect(match.currentGame.trump).toBeNull(); // still waiting on the human to set trump
    expect(match.currentGame.currentPlayerId).toBe('human-1');

    match = valueOf(await stub.setTrump('human-1', Suit.Sixes));
    expect(match.currentGame.trump).toBe(Suit.Sixes);
    expect(match.currentGame.currentPlayerId).toBe('human-1'); // the winning bidder leads

    const humanHand = match.currentGame.hands.find((h) => h.playerId === 'human-1')!.dominoes;
    match = valueOf(await stub.playDomino('human-1', humanHand[0]));
    expect(match.currentGame.tricks).toHaveLength(0); // trick not yet full

    await runAllPendingAlarms(stub);

    match = valueOf(await stub.getMatch());
    // Regardless of who won the trick, the alarm loop only ever stops once it's the human's turn
    // again - even if a bot won and had to lead the next trick.
    expect(match.currentGame.tricks).toHaveLength(1);
    expect(match.currentGame.currentPlayerId).toBe('human-1');
  });

  // The alarm syncs the lobby by the routes' rules: bot moves never change who's seated, so they
  // never rewrite match_players (and bids and trump calls write nothing at all).
  it('leaves the lobby index alone while bots bid and play', async () => {
    const lobbyWrites = await countLobbyWrites(testEnv.DB);
    const stub = stubFor('bots-lobby-sync');
    await stub.create('human-1', 'bots-lobby-sync');
    let match = valueOf(await stub.addBots('human-1'));
    // Seeded here, as the route that seats bots would: these tests call the DO directly.
    await syncLobbyIndex(testEnv.DB, match);
    const before = await lobbyWrites(match.id);
    expect(before.match_players).toBe(4);

    await stub.bid('human-1', Bid.Thirty);
    await runAllPendingAlarms(stub);
    match = valueOf(await stub.setTrump('human-1', Suit.Sixes));
    await stub.playDomino('human-1', match.currentGame.hands.find((h) => h.playerId === 'human-1')!.dominoes[0]);
    await runAllPendingAlarms(stub);

    expect(valueOf(await stub.getMatch()).currentGame.tricks).toHaveLength(1);
    // The matches row isn't written either: the match is moments old, well inside
    // SUMMARY_REFRESH_MS.
    expect(await lobbyWrites(match.id)).toEqual(before);
  });
});
