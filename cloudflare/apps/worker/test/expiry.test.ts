import { describe, it, expect, beforeEach } from 'vitest';
import {
  env,
  runInDurableObject,
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import worker, { type Env } from '../src/index';
import { expireIdleMatches } from '../src/expiry';
import { syncLobbyIndex, upsertMatchSummary } from '../src/lobby';
import { Teams, type MatchState } from '@fortytwo/rules';

const testEnv = env as unknown as Env;
const NOW = Date.parse('2026-10-01T09:00:00.000Z');
const OLD = '2026-09-01T00:00:00.000Z'; // 30 days before NOW
const RECENT = '2026-09-30T00:00:00.000Z'; // 1 day before NOW

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}

// A match created by p1 whose DO and lobby row both say it was last touched at `updatedOn`.
async function plantMatch(id: string, updatedOn: string, overrides: Partial<MatchState> = {}) {
  const stub = stubFor(id);
  const created = await stub.create('p1', id);
  const match = { ...created, updatedOn, ...overrides };
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('match', match);
  });
  await syncLobbyIndex(testEnv.DB, match);
  return stub;
}

async function lobbyRow(id: string) {
  return testEnv.DB.prepare('SELECT status, updated_on FROM matches WHERE id = ?')
    .bind(id)
    .first<{ status: string; updated_on: string }>();
}

// Wipes both lobby-index tables before each test - D1's local storage persists across tests
// within a single vitest-plugin run.
beforeEach(async () => {
  await testEnv.DB.batch([testEnv.DB.prepare('DELETE FROM match_players'), testEnv.DB.prepare('DELETE FROM matches')]);
});

describe('expireIdleMatches', () => {
  it('deletes an active match idle past the cutoff, in D1 and in its DO', async () => {
    const stub = await plantMatch('exp-old', OLD);

    const summary = await expireIdleMatches(testEnv, NOW);

    expect(summary).toEqual({ expired: 1, refreshed: 0, orphaned: 0, failed: 0 });
    expect(await lobbyRow('exp-old')).toBeNull();
    expect(await stub.getMatch()).toMatchObject({ ok: false, status: 404 });
  });

  it('leaves a recently-updated match alone', async () => {
    await plantMatch('exp-recent', RECENT);

    expect(await expireIdleMatches(testEnv, NOW)).toEqual({ expired: 0, refreshed: 0, orphaned: 0, failed: 0 });
    expect(await lobbyRow('exp-recent')).not.toBeNull();
  });

  it('never touches completed matches', async () => {
    const stub = await plantMatch('exp-completed', OLD, { winningTeam: Teams.TeamA });

    await expireIdleMatches(testEnv, NOW);

    expect((await lobbyRow('exp-completed'))?.status).toBe('completed');
    expect((await stub.getMatch()).ok).toBe(true);
  });

  it('re-syncs a stale lobby row whose DO was updated since, instead of deleting it', async () => {
    const stub = await plantMatch('exp-stale-row', RECENT);
    await upsertMatchSummary(testEnv.DB, { id: 'exp-stale-row', status: 'active', playerCount: 1, updatedOn: OLD });

    const summary = await expireIdleMatches(testEnv, NOW);

    expect(summary.refreshed).toBe(1);
    expect((await lobbyRow('exp-stale-row'))?.updated_on).toBe(RECENT);
    expect((await stub.getMatch()).ok).toBe(true);
  });

  it('removes an orphaned lobby row whose DO holds no match', async () => {
    await upsertMatchSummary(testEnv.DB, { id: 'exp-orphan', status: 'active', playerCount: 1, updatedOn: OLD });

    expect((await expireIdleMatches(testEnv, NOW)).orphaned).toBe(1);
    expect(await lobbyRow('exp-orphan')).toBeNull();
  });

  it('keeps going past a match that fails, and tries it only once per run', async () => {
    await plantMatch('exp-fails', OLD);
    await plantMatch('exp-works', '2026-09-02T00:00:00.000Z');
    const calls: string[] = [];

    const summary = await expireIdleMatches(testEnv, NOW, async (id, cutoff) => {
      calls.push(id);
      if (id === 'exp-fails') throw new Error('boom');
      return stubFor(id).expire(cutoff);
    });

    expect(summary).toEqual({ expired: 1, refreshed: 0, orphaned: 0, failed: 1 });
    expect(calls).toEqual(['exp-fails', 'exp-works']);
    expect(await lobbyRow('exp-fails')).not.toBeNull();
  });
});

describe('scheduled handler', () => {
  it('runs the sweep', async () => {
    await plantMatch('exp-cron', OLD);
    const controller = createScheduledController({ scheduledTime: NOW, cron: '0 9 * * *' });
    const ctx = createExecutionContext();

    await worker.scheduled(controller, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(await lobbyRow('exp-cron')).toBeNull();
  });
});
