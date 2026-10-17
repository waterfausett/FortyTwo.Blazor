// The played_with table (migrations/0013_people.sql): who has sat at a started game with whom,
// for the People list's recent players. Written by MatchDO when a game starts - the first deal,
// a rematch, or a newcomer taking over a seat mid-game - so a table that never filled, or a game
// against bots alone, adds nobody.
import { hasBeenDealt, isBot, type MatchState } from '@fortytwo/rules';

export interface StartedTable {
  humans: string[];
  // Only these players are new to the table; null when everyone is.
  newcomers: string[] | null;
}

export function startedPlayers(previous: MatchState | null, next: MatchState): StartedTable | null {
  if (next.players.length < 4 || !hasBeenDealt(next)) return null;
  const humans = next.players.map((p) => p.playerId).filter((id) => !isBot(id));
  if (previous === null || !hasBeenDealt(previous)) return { humans, newcomers: null };
  const before = new Set(previous.players.map((p) => p.playerId));
  const newcomers = humans.filter((id) => !before.has(id));
  return newcomers.length > 0 ? { humans, newcomers } : null;
}

export async function recordPlayedWith(db: D1Database, { humans, newcomers }: StartedTable, now: string): Promise<void> {
  const fresh = newcomers === null ? null : new Set(newcomers);
  const pairs = humans.flatMap((a) =>
    humans.filter((b) => b !== a && (fresh === null || fresh.has(a) || fresh.has(b))).map((b) => [a, b] as const)
  );
  if (pairs.length === 0) return;
  await db.batch(
    pairs.map(([a, b]) =>
      db
        .prepare(
          `INSERT INTO played_with (user_id, other_id, last_played_on, games) VALUES (?1, ?2, ?3, 1)
           ON CONFLICT (user_id, other_id) DO UPDATE SET last_played_on = ?3, games = games + 1`
        )
        .bind(a, b, now)
    )
  );
}
