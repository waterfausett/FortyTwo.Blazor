// D1-backed "lobby index": a lightweight, denormalized summary of matches for the lobby UI's
// listing/filtering needs. The Durable Object (matchDO.ts) remains the sole source of truth for
// in-progress match state; this module only reads/writes the queryable index kept in sync by
// Worker routes (a later task) after each DO mutation.
import { Teams, type MatchPlayerState } from '@fortytwo/rules';

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

export interface SeatedPlayer {
  playerId: string;
  team: Teams;
}

// Replaces the full player set for a match (delete-then-reinsert), not an incremental add. Each
// player's team comes from their seat, the same parity rule matchEngine.ts uses (even positions
// are TeamA, odd are TeamB).
export async function syncMatchPlayers(
  db: D1Database,
  matchId: string,
  players: Pick<MatchPlayerState, 'playerId' | 'position'>[]
): Promise<void> {
  const statements = [
    db.prepare('DELETE FROM match_players WHERE match_id = ?').bind(matchId),
    ...players.map(({ playerId, position }) =>
      db
        .prepare('INSERT OR IGNORE INTO match_players (match_id, player_id, team) VALUES (?, ?, ?)')
        .bind(matchId, playerId, position % 2 === 0 ? Teams.TeamA : Teams.TeamB)
    ),
  ];
  await db.batch(statements);
}

// Seated players per match, in join order: syncMatchPlayers re-inserts the whole set in
// `match.players` order on every sync, so rowid order is join order. The ids go in as one JSON
// array param (unpacked by json_each) since D1 caps bound parameters at 100 per statement and a
// long Game History could exceed that.
export async function listMatchPlayers(db: D1Database, matchIds: string[]): Promise<Map<string, SeatedPlayer[]>> {
  const byMatch = new Map<string, SeatedPlayer[]>(matchIds.map((id) => [id, []]));
  if (matchIds.length === 0) return byMatch;
  const { results } = await db
    .prepare(
      `SELECT match_id AS matchId, player_id AS playerId, team FROM match_players
       WHERE match_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`
    )
    .bind(JSON.stringify(matchIds))
    .all<{ matchId: string; playerId: string; team: Teams | null }>();
  for (const { matchId, playerId, team } of results) {
    const seated = byMatch.get(matchId);
    if (!seated) continue;
    // Rows synced before the team column existed have no team; joins alternate teams starting
    // with the creator on TeamA (see Lobby.tsx's joinTeamFor), so join order stands in for it.
    seated.push({ playerId, team: team ?? (seated.length % 2 === 0 ? Teams.TeamA : Teams.TeamB) });
  }
  return byMatch;
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
