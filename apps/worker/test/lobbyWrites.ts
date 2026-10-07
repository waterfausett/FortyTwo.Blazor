// Counts the rows written to the lobby index, per match, via test-only triggers - so a test can
// pin which actions write to match_players and the matches row (D1 bills every row written).
// Triggers rather than comparing rowids: SQLite hands a re-inserted row its old rowid back when
// it had the highest one.
const TRIGGERS = [
  ['match_players', 'AFTER INSERT ON match_players', 'NEW.match_id'],
  ['match_players', 'AFTER DELETE ON match_players', 'OLD.match_id'],
  ['matches', 'AFTER INSERT ON matches', 'NEW.id'],
  ['matches', 'AFTER UPDATE ON matches', 'NEW.id'],
] as const;

export async function countLobbyWrites(db: D1Database): Promise<(matchId: string) => Promise<Record<string, number>>> {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS lobby_writes (tbl TEXT NOT NULL, match_id TEXT NOT NULL)'),
    ...TRIGGERS.map(([tbl, when, matchId], i) =>
      db.prepare(
        `CREATE TRIGGER IF NOT EXISTS count_lobby_write_${i} ${when}
         BEGIN INSERT INTO lobby_writes (tbl, match_id) VALUES ('${tbl}', ${matchId}); END`
      )
    ),
  ]);
  return async (matchId) => {
    const { results } = await db
      .prepare('SELECT tbl, COUNT(*) AS n FROM lobby_writes WHERE match_id = ? GROUP BY tbl')
      .bind(matchId)
      .all<{ tbl: string; n: number }>();
    return { match_players: 0, matches: 0, ...Object.fromEntries(results.map(({ tbl, n }) => [tbl, n])) };
  };
}
