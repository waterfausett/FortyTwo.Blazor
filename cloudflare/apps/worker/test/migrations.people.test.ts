// The 0012 migration's backfill of played_with from the lobby index. Migrations run once, before
// any test (applyMigrations.ts), so the backfill statement is re-run here against seeded rows.
import { beforeEach, describe, expect, it } from 'vitest';
import { env, type D1Migration } from 'cloudflare:test';
import type { Env } from '../src/index';

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

function backfill(): string {
  const migration = testEnv.TEST_MIGRATIONS.find((m) => m.name.startsWith('0012_'));
  const query = migration?.queries.find((q) => q.includes('INSERT INTO played_with'));
  if (!query) throw new Error('0012 has no played_with backfill');
  return query;
}

async function seat(matchId: string, updatedOn: string, players: string[]) {
  await testEnv.DB.batch([
    testEnv.DB.prepare('INSERT INTO matches (id, status, player_count, updated_on) VALUES (?, ?, ?, ?)').bind(
      matchId,
      'completed',
      players.length,
      updatedOn
    ),
    ...players.map((id, position) =>
      testEnv.DB.prepare('INSERT INTO match_players (match_id, player_id, team, position) VALUES (?, ?, ?, ?)').bind(
        matchId,
        id,
        position % 2 === 0 ? 1 : 2,
        position
      )
    ),
  ]);
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM played_with'),
    testEnv.DB.prepare('DELETE FROM match_players'),
    testEnv.DB.prepare('DELETE FROM matches'),
  ]);
});

describe('0012 played_with backfill', () => {
  it('pairs every two humans at a full table, both ways, counting games and keeping the latest date', async () => {
    await seat('m1', '2026-10-01T00:00:00.000Z', ['ann', 'bo', 'cy', 'bot-1']);
    await seat('m2', '2026-10-05T00:00:00.000Z', ['ann', 'bo', 'bot-2', 'bot-3']);
    // Never filled, so nobody played.
    await seat('m3', '2026-10-06T00:00:00.000Z', ['ann', 'di']);

    await testEnv.DB.prepare(backfill()).run();

    const { results } = await testEnv.DB.prepare(
      'SELECT user_id, other_id, last_played_on, games FROM played_with ORDER BY user_id, other_id'
    ).all();
    expect(results).toEqual([
      { user_id: 'ann', other_id: 'bo', last_played_on: '2026-10-05T00:00:00.000Z', games: 2 },
      { user_id: 'ann', other_id: 'cy', last_played_on: '2026-10-01T00:00:00.000Z', games: 1 },
      { user_id: 'bo', other_id: 'ann', last_played_on: '2026-10-05T00:00:00.000Z', games: 2 },
      { user_id: 'bo', other_id: 'cy', last_played_on: '2026-10-01T00:00:00.000Z', games: 1 },
      { user_id: 'cy', other_id: 'ann', last_played_on: '2026-10-01T00:00:00.000Z', games: 1 },
      { user_id: 'cy', other_id: 'bo', last_played_on: '2026-10-01T00:00:00.000Z', games: 1 },
    ]);
  });
});
