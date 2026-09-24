// D1-backed "lobby index": a lightweight, denormalized summary of matches for the lobby UI's
// listing/filtering needs. The Durable Object (matchDO.ts) remains the sole source of truth for
// in-progress match state; this module only reads/writes the queryable index kept in sync by
// Worker routes (a later task) after each DO mutation.
export type MatchStatus = 'active' | 'completed';
export interface MatchSummary {
  id: string;
  status: MatchStatus;
  playerCount: number;
  updatedOn: string;
}

export async function upsertMatchSummary(db: D1Database, summary: MatchSummary): Promise<void> {
  await db
    .prepare(
      `INSERT INTO matches (id, status, player_count, updated_on) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, player_count = excluded.player_count, updated_on = excluded.updated_on`
    )
    .bind(summary.id, summary.status, summary.playerCount, summary.updatedOn)
    .run();
}

// Replaces the full player set for a match (delete-then-reinsert), not an incremental add.
export async function syncMatchPlayers(db: D1Database, matchId: string, playerIds: string[]): Promise<void> {
  const statements = [
    db.prepare('DELETE FROM match_players WHERE match_id = ?').bind(matchId),
    ...playerIds.map((playerId) =>
      db.prepare('INSERT OR IGNORE INTO match_players (match_id, player_id) VALUES (?, ?)').bind(matchId, playerId)
    ),
  ];
  await db.batch(statements);
}

export async function listActive(db: D1Database, userId: string): Promise<MatchSummary[]> {
  // NOTE: D1's `.all<MatchSummary>()` type parameter is compile-time only - it does not rename
  // runtime columns. The underlying `matches` table is snake_case (player_count, updated_on), so
  // every column that maps to a camelCase MatchSummary field must be explicitly aliased with AS,
  // or `.playerCount`/`.updatedOn` would be undefined on every returned row at runtime.
  const { results } = await db
    .prepare(
      `SELECT m.id, m.status, m.player_count AS playerCount, m.updated_on AS updatedOn
       FROM matches m JOIN match_players mp ON mp.match_id = m.id
       WHERE mp.player_id = ? AND m.status = 'active' ORDER BY m.updated_on DESC`
    )
    .bind(userId)
    .all<MatchSummary>();
  return results;
}

export async function listCompleted(db: D1Database, userId: string): Promise<MatchSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.status, m.player_count AS playerCount, m.updated_on AS updatedOn
       FROM matches m JOIN match_players mp ON mp.match_id = m.id
       WHERE mp.player_id = ? AND m.status = 'completed' ORDER BY m.updated_on DESC`
    )
    .bind(userId)
    .all<MatchSummary>();
  return results;
}

export async function listJoinable(db: D1Database, userId: string): Promise<MatchSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT id, status, player_count AS playerCount, updated_on AS updatedOn
       FROM matches WHERE status = 'active' AND player_count < 4
       AND id NOT IN (SELECT match_id FROM match_players WHERE player_id = ?)
       ORDER BY updated_on DESC, player_count DESC`
    )
    .bind(userId)
    .all<MatchSummary>();
  return results;
}
