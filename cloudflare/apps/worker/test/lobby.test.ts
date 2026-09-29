import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  upsertMatchSummary,
  syncMatchPlayers,
  listActive,
  listCompleted,
  listJoinable,
  listMatchPlayers,
} from '../src/lobby';
import { Teams } from '@fortytwo/rules';
import type { Env } from '../src/index';

const testEnv = env as unknown as Env;

// Seats players in the given order at positions 0, 1, 2, 3 - so teams alternate A, B, A, B.
function seat(...playerIds: string[]) {
  return playerIds.map((playerId, position) => ({ playerId, position }));
}

// Wipes both tables before each test so fixtures from one test can't leak into the next -
// D1's local storage persists across tests within a single vitest-pool-workers run.
beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM match_players'),
    testEnv.DB.prepare('DELETE FROM matches'),
  ]);
});

describe('lobby', () => {
  describe('listActive', () => {
    it("returns only active matches the user is in, with camelCase playerCount/updatedOn populated", async () => {
      await upsertMatchSummary(testEnv.DB, { id: 'm-active', status: 'active', playerCount: 2, updatedOn: '2026-09-24T01:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-active', seat('p1', 'p2'));

      await upsertMatchSummary(testEnv.DB, { id: 'm-completed', status: 'completed', playerCount: 4, updatedOn: '2026-09-24T02:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-completed', seat('p1', 'p2', 'p3', 'p4'));

      const results = await listActive(testEnv.DB, 'p1');

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('m-active');
      expect(results[0].status).toBe('active');
      // These are the camelCase fields the buggy `SELECT m.*`/`SELECT *` would leave undefined -
      // the runtime row is snake_case (player_count, updated_on) unless explicitly aliased.
      expect(results[0].playerCount).toBe(2);
      expect(results[0].updatedOn).toBe('2026-09-24T01:00:00Z');
      // Guard against the aliasing bug resurfacing as raw snake_case keys on the result.
      expect(results[0]).not.toHaveProperty('player_count');
      expect(results[0]).not.toHaveProperty('updated_on');
    });

    it('does not return an active match the user is not in', async () => {
      await upsertMatchSummary(testEnv.DB, { id: 'm-other', status: 'active', playerCount: 1, updatedOn: '2026-09-24T01:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-other', seat('p9'));

      const results = await listActive(testEnv.DB, 'p1');

      expect(results).toHaveLength(0);
    });
  });

  describe('listCompleted', () => {
    it('returns only completed matches the user played in, with camelCase fields populated', async () => {
      await upsertMatchSummary(testEnv.DB, { id: 'm-active', status: 'active', playerCount: 2, updatedOn: '2026-09-24T01:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-active', seat('p1', 'p2'));

      await upsertMatchSummary(testEnv.DB, { id: 'm-completed', status: 'completed', playerCount: 4, updatedOn: '2026-09-24T03:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-completed', seat('p1', 'p2', 'p3', 'p4'));

      const results = await listCompleted(testEnv.DB, 'p1');

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('m-completed');
      expect(results[0].status).toBe('completed');
      expect(results[0].playerCount).toBe(4);
      expect(results[0].updatedOn).toBe('2026-09-24T03:00:00Z');
    });

    it('does not return a completed match the user did not play in', async () => {
      await upsertMatchSummary(testEnv.DB, { id: 'm-completed-other', status: 'completed', playerCount: 4, updatedOn: '2026-09-24T03:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-completed-other', seat('p9', 'p8', 'p7', 'p6'));

      const results = await listCompleted(testEnv.DB, 'p1');

      expect(results).toHaveLength(0);
    });
  });

  describe('listJoinable', () => {
    it('excludes a match the user is already in and a full match, with camelCase fields populated', async () => {
      // Joinable: active, not full, user not already in it.
      await upsertMatchSummary(testEnv.DB, { id: 'm-joinable', status: 'active', playerCount: 2, updatedOn: '2026-09-24T04:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-joinable', seat('p2', 'p3'));

      // Not joinable: user p1 is already in it.
      await upsertMatchSummary(testEnv.DB, { id: 'm-already-in', status: 'active', playerCount: 2, updatedOn: '2026-09-24T05:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-already-in', seat('p1', 'p4'));

      // Not joinable: full (player_count >= 4).
      await upsertMatchSummary(testEnv.DB, { id: 'm-full', status: 'active', playerCount: 4, updatedOn: '2026-09-24T06:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-full', seat('p2', 'p3', 'p5', 'p6'));

      // Not joinable: completed, even though not full and user not in it.
      await upsertMatchSummary(testEnv.DB, { id: 'm-done', status: 'completed', playerCount: 2, updatedOn: '2026-09-24T07:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-done', seat('p2', 'p3'));

      const results = await listJoinable(testEnv.DB, 'p1');

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('m-joinable');
      expect(results[0].playerCount).toBe(2);
      expect(results[0].updatedOn).toBe('2026-09-24T04:00:00Z');
    });
  });

  describe('upsertMatchSummary', () => {
    it('updates status/playerCount/updatedOn in place on conflict rather than inserting a duplicate row', async () => {
      await upsertMatchSummary(testEnv.DB, { id: 'm1', status: 'active', playerCount: 1, updatedOn: '2026-09-24T01:00:00Z' });
      await upsertMatchSummary(testEnv.DB, { id: 'm1', status: 'active', playerCount: 3, updatedOn: '2026-09-24T02:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm1', seat('p1'));

      const results = await listActive(testEnv.DB, 'p1');

      expect(results).toHaveLength(1);
      expect(results[0].playerCount).toBe(3);
      expect(results[0].updatedOn).toBe('2026-09-24T02:00:00Z');
    });
  });

  describe('listMatchPlayers', () => {
    const summary = (id: string) => ({ id, status: 'active' as const, playerCount: 0, updatedOn: '2026-09-24T01:00:00Z' });

    it('groups players by match in join order with their seat-derived team', async () => {
      for (const id of ['m1', 'm2', 'm-empty']) await upsertMatchSummary(testEnv.DB, summary(id));
      await syncMatchPlayers(testEnv.DB, 'm1', seat('zed', 'bot-1', 'amy'));
      await syncMatchPlayers(testEnv.DB, 'm2', seat('p1'));
      // Re-sync m1 after m2 so its rows are newer - order must still follow the synced list.
      // Join order differs from seat order here: 'late' joined last but sits at position 1.
      await syncMatchPlayers(testEnv.DB, 'm1', [
        { playerId: 'zed', position: 0 },
        { playerId: 'amy', position: 2 },
        { playerId: 'bot-2', position: 3 },
        { playerId: 'late', position: 1 },
      ]);

      const players = await listMatchPlayers(testEnv.DB, ['m1', 'm2', 'm-empty']);

      expect(players.get('m1')).toEqual([
        { playerId: 'zed', team: Teams.TeamA, position: 0 },
        { playerId: 'amy', team: Teams.TeamA, position: 2 },
        { playerId: 'bot-2', team: Teams.TeamB, position: 3 },
        { playerId: 'late', team: Teams.TeamB, position: 1 },
      ]);
      expect(players.get('m2')).toEqual([{ playerId: 'p1', team: Teams.TeamA, position: 0 }]);
      expect(players.get('m-empty')).toEqual([]);
    });

    it('infers seats from join order for rows synced before the position column existed', async () => {
      await upsertMatchSummary(testEnv.DB, summary('legacy'));
      await testEnv.DB.batch(
        [
          ['a', Teams.TeamA],
          ['b', Teams.TeamB],
        ].map(([playerId, team]) =>
          testEnv.DB.prepare('INSERT INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)').bind('legacy', playerId, team)
        )
      );

      const players = await listMatchPlayers(testEnv.DB, ['legacy']);

      expect(players.get('legacy')).toEqual([
        { playerId: 'a', team: Teams.TeamA, position: 0 },
        { playerId: 'b', team: Teams.TeamB, position: 1 },
      ]);
    });

    it('infers teams from join order for rows synced before the team column existed', async () => {
      await upsertMatchSummary(testEnv.DB, summary('legacy'));
      await testEnv.DB.batch(
        ['a', 'b', 'c'].map((playerId) =>
          testEnv.DB.prepare('INSERT INTO match_players (match_id, player_id) VALUES (?, ?)').bind('legacy', playerId)
        )
      );

      const players = await listMatchPlayers(testEnv.DB, ['legacy']);

      expect(players.get('legacy')).toEqual([
        { playerId: 'a', team: Teams.TeamA, position: 0 },
        { playerId: 'b', team: Teams.TeamB, position: 1 },
        { playerId: 'c', team: Teams.TeamA, position: 2 },
      ]);
    });

    it('returns an empty map for no match ids', async () => {
      expect((await listMatchPlayers(testEnv.DB, [])).size).toBe(0);
    });
  });

  describe('syncMatchPlayers', () => {
    it('replaces the full player set rather than appending to it', async () => {
      await upsertMatchSummary(testEnv.DB, { id: 'm1', status: 'active', playerCount: 2, updatedOn: '2026-09-24T01:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm1', seat('p1', 'p2'));
      await syncMatchPlayers(testEnv.DB, 'm1', seat('p3'));

      // p1 was removed from m1's player set, so it should no longer show up for p1.
      const p1Results = await listActive(testEnv.DB, 'p1');
      expect(p1Results).toHaveLength(0);

      const p3Results = await listActive(testEnv.DB, 'p3');
      expect(p3Results).toHaveLength(1);
      expect(p3Results[0].id).toBe('m1');
    });
  });
});
