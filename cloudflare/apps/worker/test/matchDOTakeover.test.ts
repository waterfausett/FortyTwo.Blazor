// Seat takeover in an Over the table game, against the real MatchDO: newcomers claim bot seats,
// a player who leaves mid-game hands their seat to a bot, and a table with nobody left present is
// dropped rather than played on by bots alone. Deadlines are reached by winding the stored match's
// times back, as matchDOLive.test.ts does, then firing the alarm.
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { LIVE_ABANDON_MS, LIVE_TURN_MS, type MatchState } from '@fortytwo/rules';
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

async function windBack(stub: Stub, change: (match: MatchState) => Partial<MatchState>): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const match = (await state.storage.get<MatchState>('match'))!;
    await state.storage.put('match', { ...match, ...change(match) });
  });
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// p1 alone with three bots in a dealt Over the table game.
async function soloWithBots(name: string) {
  const stub = stubFor(name);
  await stub.create('p1', name, 'live');
  await stub.addBots('p1');
  return stub;
}

describe('seat takeover', () => {
  it('takes a claim and refuses one too many', async () => {
    const stub = await soloWithBots('to-claim');
    for (const id of ['n1', 'n2', 'n3']) expect((await stub.claimSeat(id)).ok).toBe(true);
    const fourth = await stub.claimSeat('n4');
    expect(fourth.ok).toBe(false);
  });

  it('lets a claimant cancel', async () => {
    const stub = await soloWithBots('to-cancel');
    await stub.claimSeat('n1');
    const left = await stub.leave('n1');
    expect(left.ok && !left.value.deleted && left.value.match.claims).toEqual([]);
  });

  it("gives a leaver's seat to a bot straight away, mid-hand", async () => {
    const stub = stubFor('to-leave');
    await stub.create('p1', 'to-leave', 'live');
    await stub.takeSeat('p2', 1);
    await stub.addBots('p1');
    const left = await stub.leave('p2');
    expect(left.ok && !left.value.deleted).toBe(true);
    const match = await stored(stub);
    expect(match.players.find((p) => p.position === 1)!.playerId).toMatch(/^bot-/);
    expect(match.replaced).toEqual(['p2']);
  });

  it('drops the match when the last present player leaves', async () => {
    const stub = await soloWithBots('to-last-leave');
    const left = await stub.leave('p1');
    expect(left.ok && left.value.deleted).toBe(true);
    expect((await stub.getMatch()).ok).toBe(false);
  });

  it('waits on the last present player instead of autopiloting them, then drops the match', async () => {
    const stub = await soloWithBots('to-drop');
    // Make it p1's turn: let the bots act until the table waits on p1.
    for (let i = 0; i < 10 && (await stored(stub)).currentGame.currentPlayerId !== 'p1'; i++) await runDurableObjectAlarm(stub);
    await windBack(stub, () => ({ updatedOn: ago(LIVE_TURN_MS + 1000) }));
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).autopilot ?? []).toEqual([]);

    // The solo setup never synced the lobby, so seed the row: the null check below then shows the
    // drop removed it rather than it never having been there.
    await syncLobbyIndex(testEnv.DB, await stored(stub));
    expect(await testEnv.DB.prepare('SELECT id FROM matches WHERE id = ?').bind('to-drop').first()).not.toBeNull();

    await windBack(stub, () => ({ updatedOn: ago(LIVE_TURN_MS + LIVE_ABANDON_MS + 1000) }));
    await runDurableObjectAlarm(stub);
    expect((await stub.getMatch()).ok).toBe(false);
    const row = await testEnv.DB.prepare('SELECT id FROM matches WHERE id = ?').bind('to-drop').first();
    expect(row).toBeNull();
  });

  it('tells claimants they were let go before a dropped match closes', async () => {
    const stub = await soloWithBots('to-bump');
    await stub.claimSeat('n1');
    const broadcasts = await runInDurableObject(stub, async (instance) => {
      const sent: MatchState[] = [];
      // Capture what the DO broadcasts by spying on its private broadcast.
      const original = (instance as unknown as { broadcast(m: MatchState): void }).broadcast.bind(instance);
      (instance as unknown as { broadcast(m: MatchState): void }).broadcast = (m) => {
        sent.push(m);
        original(m);
      };
      await instance.leave('p1');
      return sent;
    });
    expect(broadcasts.at(-1)!.bumped).toEqual(['n1']);
  });
});
