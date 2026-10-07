// What to call each player at the table while their display names are looked up
// (POST /api/users/search). A raw player id is never shown: while a name is on its way the screen
// shows a placeholder, and a player the lookup couldn't name is called by their seat ("Player 2").
// Each app's usePlayerNames hook does the fetching and caching; this decides what it means.

export type PlayerName =
  | { status: 'loaded'; name: string }
  | { status: 'loading' }
  | { status: 'failed'; name: string };

export interface NameLookup {
  myPlayerId: string | null | undefined;
  players: readonly { playerId: string; position: number }[];
  // Every name known so far - the latest lookup's, or earlier ones' while it's still out.
  names: ReadonlyMap<string, string> | undefined;
  // The lookup for the players seated now has come back. Anyone it left out isn't coming.
  settled: boolean;
  // The lookup for the players seated now failed.
  failed: boolean;
}

export function playerName(playerId: string, lookup: NameLookup): PlayerName {
  if (playerId === lookup.myPlayerId) return { status: 'loaded', name: 'You' };
  const name = lookup.names?.get(playerId);
  if (name != null) return { status: 'loaded', name };
  if (!lookup.settled && !lookup.failed) return { status: 'loading' };
  const seat = lookup.players.find((p) => p.playerId === playerId);
  return { status: 'failed', name: seat ? `Player ${seat.position + 1}` : 'A player' };
}

// The name to put in a sentence, or null while it's still loading.
export function nameText(name: PlayerName): string | null {
  return name.status === 'loading' ? null : name.name;
}

export function missingIds(ids: readonly string[], known: ReadonlyMap<string, string>): string[] {
  return ids.filter((id) => !known.has(id));
}

export function mergeNames(...maps: (ReadonlyMap<string, string> | undefined)[]): Map<string, string> {
  const merged = new Map<string, string>();
  for (const map of maps) for (const [id, name] of map ?? []) merged.set(id, name);
  return merged;
}
