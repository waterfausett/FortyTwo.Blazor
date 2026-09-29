// D1-backed "lobby index": a lightweight, denormalized summary of matches for the lobby UI's
// listing/filtering needs. The Durable Object (matchDO.ts) remains the sole source of truth for
// match state; this index is synced from it after each change - by routes/matches.ts, or by
// MatchDO itself for the changes no route makes (bot moves, a rematch).
import { teamForPosition, type MatchPlayerState, type MatchState, type Teams } from '@fortytwo/rules';
import type { MatchSummary } from '@fortytwo/api-types';

// One row of the `matches` table. GET /api/matches adds each match's teams and seats to make the
// full MatchSummary.
export type MatchIndexRow = Omit<MatchSummary, 'teams' | 'seats'>;

// Brings a match's summary row and seated players up to date.
export async function syncLobbyIndex(db: D1Database, match: MatchState): Promise<void> {
  await upsertMatchSummary(db, {
    id: match.id,
    status: match.winningTeam ? 'completed' : 'active',
    playerCount: match.players.length,
    updatedOn: match.updatedOn,
  });
  await syncMatchPlayers(db, match.id, match.players);
}

export async function upsertMatchSummary(db: D1Database, summary: MatchIndexRow): Promise<void> {
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
  position: number;
}

// Replaces the full player set for a match (delete-then-reinsert), not an incremental add. Each
// player's team comes from their seat.
export async function syncMatchPlayers(
  db: D1Database,
  matchId: string,
  players: Pick<MatchPlayerState, 'playerId' | 'position'>[]
): Promise<void> {
  const statements = [
    db.prepare('DELETE FROM match_players WHERE match_id = ?').bind(matchId),
    ...players.map(({ playerId, position }) =>
      db
        .prepare('INSERT OR IGNORE INTO match_players (match_id, player_id, team, position) VALUES (?, ?, ?, ?)')
        .bind(matchId, playerId, teamForPosition(position), position)
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
      `SELECT match_id AS matchId, player_id AS playerId, team, position FROM match_players
       WHERE match_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`
    )
    .bind(JSON.stringify(matchIds))
    .all<{ matchId: string; playerId: string; team: Teams | null; position: number | null }>();
  for (const { matchId, playerId, team, position } of results) {
    const seated = byMatch.get(matchId);
    if (!seated) continue;
    // Rows synced before the position column existed have no seat. Before players could pick
    // seats, joins alternated teams starting with the creator on TeamA, which puts the Nth
    // joiner in seat N - so join order stands in for it (and, before the team column, for team).
    const seat = position ?? seated.length;
    seated.push({ playerId, team: team ?? teamForPosition(seat), position: seat });
  }
  return byMatch;
}

export async function listActive(db: D1Database, userId: string): Promise<MatchIndexRow[]> {
  // NOTE: D1's `.all<MatchIndexRow>()` type parameter is compile-time only - it does not rename
  // runtime columns. The underlying `matches` table is snake_case (player_count, updated_on), so
  // every column that maps to a camelCase MatchIndexRow field must be explicitly aliased with AS,
  // or `.playerCount`/`.updatedOn` would be undefined on every returned row at runtime.
  const { results } = await db
    .prepare(
      `SELECT m.id, m.status, m.player_count AS playerCount, m.updated_on AS updatedOn
       FROM matches m JOIN match_players mp ON mp.match_id = m.id
       WHERE mp.player_id = ? AND m.status = 'active' ORDER BY m.updated_on DESC`
    )
    .bind(userId)
    .all<MatchIndexRow>();
  return results;
}

export async function listCompleted(db: D1Database, userId: string): Promise<MatchIndexRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.status, m.player_count AS playerCount, m.updated_on AS updatedOn
       FROM matches m JOIN match_players mp ON mp.match_id = m.id
       WHERE mp.player_id = ? AND m.status = 'completed' ORDER BY m.updated_on DESC`
    )
    .bind(userId)
    .all<MatchIndexRow>();
  return results;
}

export async function listJoinable(db: D1Database, userId: string): Promise<MatchIndexRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, status, player_count AS playerCount, updated_on AS updatedOn
       FROM matches WHERE status = 'active' AND player_count < 4
       AND id NOT IN (SELECT match_id FROM match_players WHERE player_id = ?)
       ORDER BY updated_on DESC, player_count DESC`
    )
    .bind(userId)
    .all<MatchIndexRow>();
  return results;
}
