// Live matches' own clock (live.ts's liveDeadline, run by MatchDO's alarm): bots take a Live
// table's empty seats LIVE_FILL_MS after it began looking, and nothing of the sort happens to Daily
// or custom tables. Deadlines are reached by winding the stored match's times back, as
// matchDOPoke.test.ts does, then firing the alarm.
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { LIVE_FILL_MS, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';

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
