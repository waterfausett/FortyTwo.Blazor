// "Whose turn is it?" for the lobby's Active list, asked of each match's MatchDO as the page
// loads rather than kept in D1, which would cost a write on every turn. Each answer gets
// TURN_LOOKUP_MS; a match that doesn't answer in time, or fails, shows without a turn - the list
// itself never waits longer or fails for it.
import type { TurnSummary } from '@fortytwo/api-types';
import type { Env } from './index';
import type { TableWait } from '@fortytwo/rules';
import type { MatchResult } from './matchDO';
import type { MatchIndexRow } from './lobby';

export const TURN_LOOKUP_MS = 500;

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Each row's turn, by match id. Only a dealt match (four seated) has one worth asking for.
export async function turnsFor(
  env: Env,
  rows: MatchIndexRow[],
  viewerId: string,
  nameOf: (playerId: string) => string
): Promise<Map<string, TurnSummary | null>> {
  const entries = await Promise.all(
    rows.map(async (row): Promise<[string, TurnSummary | null]> => {
      if (row.status !== 'active' || row.playerCount < 4) return [row.id, null];
      const stub = env.MATCH_DO.get(env.MATCH_DO.idFromName(row.id));
      const result = await withTimeout<MatchResult<TableWait | null>>(stub.getTurn(), TURN_LOOKUP_MS);
      if (!result?.ok) return [row.id, null];
      if (result.value === null) return [row.id, null];
      const { kind, playerIds } = result.value;
      return [row.id, { kind, yours: playerIds.includes(viewerId), waitingOn: playerIds.map(nameOf) }];
    })
  );
  return new Map(entries);
}
