import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { upsertMatchSummary, syncMatchPlayers, listActive, listCompleted, listJoinable } from '../src/lobby';
import type { Env } from '../src/index';

const testEnv = env as unknown as Env;

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
      await syncMatchPlayers(testEnv.DB, 'm-active', ['p1', 'p2']);

      await upsertMatchSummary(testEnv.DB, { id: 'm-completed', status: 'completed', playerCount: 4, updatedOn: '2026-09-24T02:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-completed', ['p1', 'p2', 'p3', 'p4']);

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
      await syncMatchPlayers(testEnv.DB, 'm-other', ['p9']);

      const results = await listActive(testEnv.DB, 'p1');

      expect(results).toHaveLength(0);
    });
  });

  describe('listCompleted', () => {
    it('returns only completed matches the user played in, with camelCase fields populated', async () => {
      await upsertMatchSummary(testEnv.DB, { id: 'm-active', status: 'active', playerCount: 2, updatedOn: '2026-09-24T01:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-active', ['p1', 'p2']);

      await upsertMatchSummary(testEnv.DB, { id: 'm-completed', status: 'completed', playerCount: 4, updatedOn: '2026-09-24T03:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-completed', ['p1', 'p2', 'p3', 'p4']);

      const results = await listCompleted(testEnv.DB, 'p1');

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('m-completed');
      expect(results[0].status).toBe('completed');
      expect(results[0].playerCount).toBe(4);
      expect(results[0].updatedOn).toBe('2026-09-24T03:00:00Z');
    });

    it('does not return a completed match the user did not play in', async () => {
      await upsertMatchSummary(testEnv.DB, { id: 'm-completed-other', status: 'completed', playerCount: 4, updatedOn: '2026-09-24T03:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-completed-other', ['p9', 'p8', 'p7', 'p6']);

      const results = await listCompleted(testEnv.DB, 'p1');

      expect(results).toHaveLength(0);
    });
  });

  describe('listJoinable', () => {
    it('excludes a match the user is already in and a full match, with camelCase fields populated', async () => {
      // Joinable: active, not full, user not already in it.
      await upsertMatchSummary(testEnv.DB, { id: 'm-joinable', status: 'active', playerCount: 2, updatedOn: '2026-09-24T04:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-joinable', ['p2', 'p3']);

      // Not joinable: user p1 is already in it.
      await upsertMatchSummary(testEnv.DB, { id: 'm-already-in', status: 'active', playerCount: 2, updatedOn: '2026-09-24T05:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-already-in', ['p1', 'p4']);

      // Not joinable: full (player_count >= 4).
      await upsertMatchSummary(testEnv.DB, { id: 'm-full', status: 'active', playerCount: 4, updatedOn: '2026-09-24T06:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-full', ['p2', 'p3', 'p5', 'p6']);

      // Not joinable: completed, even though not full and user not in it.
      await upsertMatchSummary(testEnv.DB, { id: 'm-done', status: 'completed', playerCount: 2, updatedOn: '2026-09-24T07:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm-done', ['p2', 'p3']);

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
      await syncMatchPlayers(testEnv.DB, 'm1', ['p1']);

      const results = await listActive(testEnv.DB, 'p1');

      expect(results).toHaveLength(1);
      expect(results[0].playerCount).toBe(3);
      expect(results[0].updatedOn).toBe('2026-09-24T02:00:00Z');
    });
  });

  describe('syncMatchPlayers', () => {
    it('replaces the full player set rather than appending to it', async () => {
      await upsertMatchSummary(testEnv.DB, { id: 'm1', status: 'active', playerCount: 2, updatedOn: '2026-09-24T01:00:00Z' });
      await syncMatchPlayers(testEnv.DB, 'm1', ['p1', 'p2']);
      await syncMatchPlayers(testEnv.DB, 'm1', ['p3']);

      // p1 was removed from m1's player set, so it should no longer show up for p1.
      const p1Results = await listActive(testEnv.DB, 'p1');
      expect(p1Results).toHaveLength(0);

      const p3Results = await listActive(testEnv.DB, 'p3');
      expect(p3Results).toHaveLength(1);
      expect(p3Results[0].id).toBe('m1');
    });
  });
});
