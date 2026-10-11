// Live matches' own clock (live.ts's liveDeadline, run by MatchDO's alarm): bots take a Live
// table's empty seats LIVE_FILL_MS after it began looking, and nothing of the sort happens to Daily
// or custom tables. Deadlines are reached by winding the stored match's times back, as
// matchDOPoke.test.ts does, then firing the alarm.
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { LIVE_FILL_MS, LIVE_TURN_MS, createDomino, type Domino, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import { noticesFor } from '../src/matchDO';
import { pushNotices } from '../src/push/notices';

const testEnv = env as unknown as Env;

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}
type Stub = ReturnType<typeof stubFor>;

async function stored(stub: Stub): Promise<MatchState> {
  return runInDurableObject(stub, async (_instance, state) => (await state.storage.get<MatchState>('match'))!);
}

async function windBack(stub: Stub, change: (match: MatchState) => Partial<MatchState>): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const match = (await state.storage.get<MatchState>('match'))!;
    await state.storage.put('match', { ...match, ...change(match) });
  });
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe('Live bot fill', () => {
  it('stores the mode it was created with', async () => {
    const stub = stubFor('live-mode');
    const match = await stub.create('p1', 'live-mode', 'live');
    expect(match.mode).toBe('live');
    expect(match.searchStartedOn).toEqual(expect.any(String));
  });

  it('arms an alarm for the fill as soon as a Live table is created', async () => {
    const stub = stubFor('live-armed');
    await stub.create('p1', 'live-armed', 'live');
    const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(alarm).toEqual(expect.any(Number));
  });

  it('does nothing when the alarm fires before the deadline', async () => {
    const stub = stubFor('live-early');
    await stub.create('p1', 'live-early', 'live');
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).players).toHaveLength(1);
  });

  it('fills the empty seats with bots once the deadline passes, and deals', async () => {
    const stub = stubFor('live-fill');
    await stub.create('p1', 'live-fill', 'live');
    await stub.takeSeat('p2', 2);
    await windBack(stub, () => ({ searchStartedOn: ago(LIVE_FILL_MS + 1000) }));

    await runDurableObjectAlarm(stub);

    const match = await stored(stub);
    expect(match.players.map((p) => p.playerId).sort()).toEqual(['bot-1', 'bot-2', 'p1', 'p2']);
    expect(match.currentGame.hands.every((h) => h.dominoes.length === 7)).toBe(true);
    const row = await testEnv.DB.prepare('SELECT player_count FROM matches WHERE id = ?').bind('live-fill').first<{ player_count: number }>();
    expect(row?.player_count).toBe(4);
  });

  it('never fills a Daily or custom table', async () => {
    for (const mode of ['daily', 'custom'] as const) {
      const name = `no-fill-${mode}`;
      const stub = stubFor(name);
      await stub.create('p1', name, mode);
      await windBack(stub, () => ({ createdOn: ago(LIVE_FILL_MS * 10), updatedOn: ago(LIVE_FILL_MS * 10) }));
      expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();
    }
  });

  it('leaves no alarm behind once a cancelled search deletes the match', async () => {
    const stub = stubFor('live-cancel');
    await stub.create('p1', 'live-cancel', 'live');
    await stub.leave('p1');
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();
  });
});

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

async function dealtLive(name: string): Promise<Stub> {
  const stub = stubFor(name);
  await stub.create('p1', name, 'live');
  await stub.takeSeat('p2', 1);
  await stub.takeSeat('p3', 2);
  await stub.takeSeat('p4', 3, deck());
  return stub;
}

describe('Live turn timeout', () => {
  it('leaves the player alone before their minute is up', async () => {
    const stub = await dealtLive('turn-early');
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).autopilot ?? []).toEqual([]);
  });

  it('puts the player on autopilot when their turn runs out, and a bot then moves for them', async () => {
    const stub = await dealtLive('turn-timeout');
    const turn = (await stored(stub)).currentGame.currentPlayerId!;
    await windBack(stub, () => ({ updatedOn: ago(LIVE_TURN_MS + 1000) }));

    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).autopilot).toEqual([turn]);

    await runDurableObjectAlarm(stub);
    const after = await stored(stub);
    expect(after.currentGame.hands.find((h) => h.playerId === turn)!.bid).not.toBeNull();
  });

  it('takes a player off autopilot when they act', async () => {
    const stub = await dealtLive('turn-act');
    await windBack(stub, (m) => ({ autopilot: [m.currentGame.currentPlayerId!] }));
    const turn = (await stored(stub)).currentGame.currentPlayerId!;
    // A pass is always legal unless forced; the first bidder is never forced.
    const result = await stub.bid(turn, 0);
    expect(result.ok).toBe(true);
    expect((await stored(stub)).autopilot).toEqual([]);
  });

  it('lets a player resume without acting, and their clock starts over', async () => {
    const stub = await dealtLive('turn-resume');
    const turn = (await stored(stub)).currentGame.currentPlayerId!;
    await windBack(stub, () => ({ autopilot: [turn], updatedOn: ago(LIVE_TURN_MS * 3) }));

    const result = await stub.resume(turn);

    expect(result.ok).toBe(true);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).autopilot).toEqual([]);
  });
});

describe('getTurn', () => {
  it('says whose turn it is', async () => {
    const stub = await dealtLive('get-turn');
    const turn = (await stored(stub)).currentGame.currentPlayerId!;
    expect(await stub.getTurn()).toEqual({ ok: true, value: { kind: 'turn', playerIds: [turn] } });
  });

  it('is null while the table is filling', async () => {
    const stub = stubFor('get-turn-filling');
    await stub.create('p1', 'get-turn-filling', 'daily');
    expect(await stub.getTurn()).toEqual({ ok: true, value: null });
  });
});

describe('noticesFor', () => {
  it("drops a turn notice for a player on autopilot, and keeps everyone else's", async () => {
    const stub = await dealtLive('quiet-notices');
    const before = await stored(stub);
    const turn = before.currentGame.currentPlayerId!;
    const next = { ...before, autopilot: [turn] };
    // The deal itself produced notices; recompute them as if from an undealt table.
    const undealt = { ...before, currentGame: { ...before.currentGame, hands: before.currentGame.hands.map((h) => ({ ...h, dominoes: [] })) } };
    const all = pushNotices(undealt, next);
    const kept = noticesFor(undealt, next, new Set());
    expect(all.some((n) => n.playerId === turn)).toBe(true);
    expect(kept.some((n) => n.playerId === turn)).toBe(false);
    expect(kept.length).toBe(all.length - all.filter((n) => n.playerId === turn).length);
  });
});
