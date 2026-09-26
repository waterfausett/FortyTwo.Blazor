// Exercises AUTO_PLAY_BOTS end to end against the real MatchDO: seat-filling on create, then the
// alarm-paced bot loop carrying bidding/trump/play forward up to the human's next turn. The
// AUTO_PLAY_BOTS binding isn't set globally (vitest.config.ts's bindings apply to every test file
// in this pool, and other tests - matchDO.test.ts, matchLifecycle.test.ts - manually addPlayer with
// their own ids and would break if bots auto-filled the match out from under them). Instead, each
// call here reaches into the live DO instance via `runInDurableObject` and overrides its `env`
// just for that call - `handleRpc`'s AUTO_PLAY_BOTS check only ever runs synchronously inside that
// same call, so it doesn't matter whether the runtime re-constructs the instance between calls.
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { Bid, Suit, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import type { MatchDO } from '../src/matchDO';

const testEnv = env as unknown as Env;

function stubFor(name: string) {
  const id = testEnv.MATCH_DO.idFromName(name);
  return testEnv.MATCH_DO.get(id);
}

async function rpcWithBots(
  stub: ReturnType<typeof stubFor>,
  method: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  return runInDurableObject(stub, async (instance) => {
    // Two views of the same instance: `MatchDO.env` is private, so intersecting it with a public
    // `{ env }` would collapse to `never`.
    const withEnv = instance as unknown as { env: Env };
    withEnv.env = { ...withEnv.env, AUTO_PLAY_BOTS: 'true' };
    const res = await (instance as MatchDO).fetch(
      new Request(`https://do/rpc/${method}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      })
    );
    const json = await res.json();
    return { status: res.status, body: json };
  });
}

async function runAllPendingAlarms(stub: ReturnType<typeof stubFor>, maxTicks = 20): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    const ran = await runDurableObjectAlarm(stub);
    if (!ran) return;
  }
  throw new Error('too many bot alarm ticks - possible infinite loop');
}

describe('MatchDO bot auto-play', () => {
  it('fills the other 3 seats with bots on create, dealing a full hand to everyone', async () => {
    const stub = stubFor('bots-create');

    const created = await rpcWithBots(stub, 'create', { firstPlayerId: 'human-1' });

    expect(created.status).toBe(200);
    const match = created.body as MatchState;
    expect(match.players.map((p) => p.playerId).sort()).toEqual(['bot-1', 'bot-2', 'bot-3', 'human-1']);
    expect(match.currentGame.hands.every((h) => h.dominoes.length === 7)).toBe(true);
  });

  it("bots auto-bid, auto-set-trump, and auto-play up to the human's next turn", async () => {
    const stub = stubFor('bots-bid-and-play');

    const created = await rpcWithBots(stub, 'create', { firstPlayerId: 'human-1' });
    let match = created.body as MatchState;
    expect(match.currentGame.currentPlayerId).toBe('human-1');

    // Human bids the minimum; bots always pass, so human wins the bid outright.
    const bidRes = await rpcWithBots(stub, 'bid', { playerId: 'human-1', bid: Bid.Thirty });
    match = bidRes.body as MatchState;
    expect(match.currentGame.hands.some((h) => h.bid === null)).toBe(true); // bots haven't acted yet

    await runAllPendingAlarms(stub);

    const afterBidding = await rpcWithBots(stub, 'getMatch', {});
    match = afterBidding.body as MatchState;
    expect(match.currentGame.hands.every((h) => h.bid !== null)).toBe(true);
    expect(match.currentGame.biddingPlayerId).toBe('human-1');
    expect(match.currentGame.trump).toBeNull(); // still waiting on the human to set trump
    expect(match.currentGame.currentPlayerId).toBe('human-1');

    const trumpRes = await rpcWithBots(stub, 'setTrump', { playerId: 'human-1', suit: Suit.Sixes });
    match = trumpRes.body as MatchState;
    expect(match.currentGame.trump).toBe(Suit.Sixes);
    expect(match.currentGame.currentPlayerId).toBe('human-1'); // the winning bidder leads

    const humanHand = match.currentGame.hands.find((h) => h.playerId === 'human-1')!.dominoes;
    const playRes = await rpcWithBots(stub, 'playDomino', { playerId: 'human-1', domino: humanHand[0] });
    match = playRes.body as MatchState;
    expect(match.currentGame.tricks).toHaveLength(0); // trick not yet full

    await runAllPendingAlarms(stub);

    const afterTrick = await rpcWithBots(stub, 'getMatch', {});
    match = afterTrick.body as MatchState;
    // Regardless of who won the trick, the alarm loop only ever stops once it's the human's turn
    // again - even if a bot won and had to lead the next trick.
    expect(match.currentGame.tricks).toHaveLength(1);
    expect(match.currentGame.currentPlayerId).toBe('human-1');
  });
});
