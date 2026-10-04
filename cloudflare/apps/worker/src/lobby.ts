// D1-backed "lobby index": a lightweight, denormalized summary of matches for the lobby UI's
// listing/filtering needs. The Durable Object (matchDO.ts) remains the sole source of truth for
// match state; this index is synced from it after each change - by routes/matches.ts, or by
// MatchDO itself for the changes no route makes (bot moves, a rematch). Every sync runs through
// `bestEffort`: by then the match is already saved, so a D1 failure must not fail the change.
import { teamForPosition, type MatchPlayerState, type MatchState, type Teams } from '@fortytwo/rules';
import type { MatchSummary } from '@fortytwo/api-types';

// One row of the `matches` table. GET /api/matches adds each match's teams and seats to make the
// full MatchSummary.
export type MatchIndexRow = Omit<MatchSummary, 'teams' | 'seats'>;

// Lobby lists come one page at a time, newest first. A page ends at its last row's
// (updatedOn, id); the next page starts strictly after it.
export const LOBBY_PAGE_SIZE = 20;

export interface LobbyCursor {
  updatedOn: string;
  id: string;
}

export interface LobbyPage {
  rows: MatchIndexRow[];
  next: LobbyCursor | null;
}

// Runs a lobby index write for `matchId`, logging rather than throwing if it fails. The change it
// mirrors has already been saved in the match's DO, so failing now would only tell the client a
// move went wrong when it didn't (and a retry would then be refused). The index lags until the
// match's next successful sync catches it up (or, for a stale or orphaned row, the expiry sweep).
export async function bestEffort(matchId: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    console.error(`Failed to sync the lobby index for match ${matchId}`, error);
  }
}

// Brings a match's summary row and seated players up to date. For a change to who's seated: a
// create, join, leave, bots or rematch. Anything else uses refreshMatchSummary, which writes far less.
export async function syncLobbyIndex(db: D1Database, match: MatchState): Promise<void> {
  await upsertMatchSummary(db, {
    id: match.id,
    status: matchStatus(match),
    playerCount: match.players.length,
    updatedOn: match.updatedOn,
  });
  await syncMatchPlayers(db, match.id, match.players);
}

// D1 bills every row (and index entry) written, and a match changes on every play, so a change
// that leaves the seats alone rewrites at most the match's own row: when its status or player
// count changed (status is indexed, so it's only set then), or to refresh updated_on once it's
// this far behind. The lobby orders by updated_on, so a match can sit up to this long below one
// that moved more recently. (Rewriting every seat on every move used up the day's D1 writes.)
export const SUMMARY_REFRESH_MS = 5 * 60 * 1000;

export async function refreshMatchSummary(db: D1Database, match: MatchState): Promise<void> {
  const refreshBefore = new Date(Date.parse(match.updatedOn) - SUMMARY_REFRESH_MS).toISOString();
  await db.batch([
    db
      .prepare(
        `UPDATE matches SET status = ?2, player_count = ?3, updated_on = ?4
         WHERE id = ?1 AND (status IS NOT ?2 OR player_count IS NOT ?3)`
      )
      .bind(match.id, matchStatus(match), match.players.length, match.updatedOn),
    db
      .prepare('UPDATE matches SET updated_on = ?2 WHERE id = ?1 AND updated_on < ?3')
      .bind(match.id, match.updatedOn, refreshBefore),
  ]);
}

function matchStatus(match: MatchState): MatchIndexRow['status'] {
  return match.winningTeam ? 'completed' : 'active';
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

// Drops a deleted match from the lobby: its seats first, then the match row they reference.
export async function deleteFromLobbyIndex(db: D1Database, matchId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM match_players WHERE match_id = ?').bind(matchId),
    db.prepare('DELETE FROM matches WHERE id = ?').bind(matchId),
  ]);
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
// `match.players` order whenever the seats change, so rowid order is join order. The ids go in as
// one JSON array param (unpacked by json_each) since D1 caps bound parameters at 100 per statement
// and a long Game History could exceed that.
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

// One more row than a page is fetched; if it comes back, there's another page after this one.
function toPage(results: MatchIndexRow[]): LobbyPage {
  const rows = results.slice(0, LOBBY_PAGE_SIZE);
  const last = rows[rows.length - 1];
  const next = results.length > LOBBY_PAGE_SIZE ? { updatedOn: last.updatedOn, id: last.id } : null;
  return { rows, next };
}

// Matches the user is seated in with the given status, a page at a time.
//
// NOTE: D1's `.all<MatchIndexRow>()` type parameter is compile-time only - it does not rename
// runtime columns. The underlying `matches` table is snake_case (player_count, updated_on), so
// every column that maps to a camelCase MatchIndexRow field must be explicitly aliased with AS,
// or `.playerCount`/`.updatedOn` would be undefined on every returned row at runtime.
async function listForPlayer(
  db: D1Database,
  userId: string,
  status: 'active' | 'completed',
  cursor: LobbyCursor | null
): Promise<LobbyPage> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.status, m.player_count AS playerCount, m.updated_on AS updatedOn
       FROM matches m JOIN match_players mp ON mp.match_id = m.id
       WHERE mp.player_id = ?1 AND m.status = ?2
       AND (?3 IS NULL OR (m.updated_on, m.id) < (?3, ?4))
       ORDER BY m.updated_on DESC, m.id DESC LIMIT ?5`
    )
    .bind(userId, status, cursor?.updatedOn ?? null, cursor?.id ?? null, LOBBY_PAGE_SIZE + 1)
    .all<MatchIndexRow>();
  return toPage(results);
}

export function listActive(db: D1Database, userId: string, cursor: LobbyCursor | null = null): Promise<LobbyPage> {
  return listForPlayer(db, userId, 'active', cursor);
}

export function listCompleted(db: D1Database, userId: string, cursor: LobbyCursor | null = null): Promise<LobbyPage> {
  return listForPlayer(db, userId, 'completed', cursor);
}

export async function listJoinable(db: D1Database, userId: string, cursor: LobbyCursor | null = null): Promise<LobbyPage> {
  const { results } = await db
    .prepare(
      `SELECT id, status, player_count AS playerCount, updated_on AS updatedOn
       FROM matches WHERE status = 'active' AND player_count < 4
       AND id NOT IN (SELECT match_id FROM match_players WHERE player_id = ?1)
       AND (?2 IS NULL OR (updated_on, id) < (?2, ?3))
       ORDER BY updated_on DESC, id DESC LIMIT ?4`
    )
    .bind(userId, cursor?.updatedOn ?? null, cursor?.id ?? null, LOBBY_PAGE_SIZE + 1)
    .all<MatchIndexRow>();
  return toPage(results);
}
