// Exercises the bots end to end against the real MatchDO: seating bots on demand (one
// seat, or every open seat), then the alarm-paced bot loop carrying bidding/trump/play forward up
// to a human's next turn. The pool pins BOTS_ENABLED to 'false' and serves no model, so these
// bots play by the simple rules; the kill switch only turns the ML bot off, not the alarm loop.
import { describe, it, expect, vi } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { Bid, Suit, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import type { MatchDO } from '../src/matchDO';
import { syncLobbyIndex } from '../src/lobby';
import { countLobbyWrites } from './lobbyWrites';
import { failingDb } from './failingDb';
import { warmUpSteps } from '@fortytwo/bot';
import { resetMlBotForTest } from '../src/mlBot';

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

  // Each bot play syncs the lobby's summary row. If that write fails, the bots must still play on:
  // nothing a human can do would schedule them again.
  it('keeps the bots playing while the lobby index is down', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = stubFor('bots-no-db');
    await stub.create('human-1', 'bots-no-db');
    await stub.addBots('human-1');
    await stub.bid('human-1', Bid.Thirty);
    await runAllPendingAlarms(stub);
    let match = valueOf(await stub.setTrump('human-1', Suit.Sixes));

    // `MatchDO.env` is protected, so the instance is viewed through a public `{ env }` to swap in
    // a D1 that fails. The swap lasts for this instance, so the alarms below run with it too.
    let realEnv: Env | undefined;
    await runInDurableObject(stub, async (instance: MatchDO) => {
      const withEnv = instance as unknown as { env: Env };
      realEnv = withEnv.env;
      withEnv.env = { ...realEnv, DB: failingDb() };
    });
    try {
      const lead = match.currentGame.hands.find((h) => h.playerId === 'human-1')!.dominoes[0];
      await stub.playDomino('human-1', lead);
      await runAllPendingAlarms(stub);

      match = valueOf(await stub.getMatch());
      expect(match.currentGame.tricks).toHaveLength(1);
      expect(match.currentGame.currentPlayerId).toBe('human-1');
      expect(logged).toHaveBeenCalledWith('Failed to sync the lobby index for match bots-no-db', expect.any(Error));
    } finally {
      await runInDurableObject(stub, async (instance: MatchDO) => {
        (instance as unknown as { env: Env }).env = realEnv!;
      });
      logged.mockRestore();
    }
  });

  // The kill switch reaches matches that already have bots: their alarms use the simple rules and
  // never load the ML bot, so the match still advances. Shown against an ASSETS that would serve
  // a real (tiny) model, and checked against BOTS_ENABLED on, which does load it.
  describe('with a model available', () => {
    function modelAssets(): { assets: Fetcher; fetches: () => number } {
      const bin = Uint8Array.from(atob(env.TINY_BOT_BIN_B64), (c) => c.charCodeAt(0));
      const files: Record<string, BodyInit> = { '/models/bot.json': env.TINY_BOT_JSON, '/models/bot.bin': bin };
      let n = 0;
      const assets = {
        fetch: async (req: Request) => {
          n++;
          const body = files[new URL(req.url).pathname];
          return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
        },
      } as unknown as Fetcher;
      return { assets, fetches: () => n };
    }

    // A match where the human has opened the bidding and bot-1 is next, in a fresh isolate (no
    // ML bot loaded yet).
    async function humanHasBid(name: string, botsEnabled: string, assets: Fetcher) {
      resetMlBotForTest();
      const stub = stubFor(name);
      await stub.create('human-1', name);
      await stub.addBots('human-1');
      await runInDurableObject(stub, async (instance: MatchDO) => {
        const withEnv = instance as unknown as { env: Env };
        withEnv.env = { ...withEnv.env, BOTS_ENABLED: botsEnabled, ASSETS: assets };
      });
      await stub.bid('human-1', Bid.Thirty);
      return stub;
    }

    async function botsBidWith(name: string, botsEnabled: string, assets: Fetcher): Promise<MatchState> {
      const stub = await humanHasBid(name, botsEnabled, assets);
      await runAllPendingAlarms(stub);
      return valueOf(await stub.getMatch());
    }

    it("keeps bots playing by the simple rules, without the ML bot, when BOTS_ENABLED is 'false'", async () => {
      const { assets, fetches } = modelAssets();
      const match = await botsBidWith('bots-kill-switch', 'false', assets);

      expect(fetches()).toBe(0);
      // Every bot bid (the match advanced), each a simple bot's pass over the human's 30.
      expect(match.currentGame.hands.filter((h) => h.playerId !== 'human-1').map((h) => h.bid)).toEqual([
        Bid.Pass, Bid.Pass, Bid.Pass,
      ]);
      expect(match.currentGame.currentPlayerId).toBe('human-1');
    });

    it('loads the ML bot for those alarms when BOTS_ENABLED is on', async () => {
      const { assets, fetches } = modelAssets();
      const match = await botsBidWith('bots-ml-on', 'true', assets);

      expect(fetches()).toBe(2);
      expect(match.currentGame.hands.every((h) => h.bid !== null)).toBe(true);
    });

    // Loading and each warm-up step get an alarm of their own (each a share of the Free plan's
    // 10 ms CPU), and none of them touches the match; the alarm after them makes the bot's move.
    it('spends the first alarms in a fresh isolate loading and warming up, without touching the match', async () => {
      const { assets } = modelAssets();
      const stub = await humanHasBid('bots-ml-warming', 'true', assets);
      const before = valueOf(await stub.getMatch());

      for (let tick = 0; tick < 1 + warmUpSteps().steps.length; tick++) {
        expect(await runDurableObjectAlarm(stub)).toBe(true);
        expect(valueOf(await stub.getMatch())).toEqual(before);
      }
      expect(await runDurableObjectAlarm(stub)).toBe(true);
      const after = valueOf(await stub.getMatch());
      expect(after.currentGame.hands.find((h) => h.playerId === 'bot-1')!.bid).not.toBeNull();
      await runAllPendingAlarms(stub); // none left running when the test ends
    });
  });
});
