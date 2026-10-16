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

// Who each row's match is waiting on, by match id (null: not dealt, over, unanswered). Only a dealt
// match (four seated) has one worth asking for. Started before the names are fetched, so the two
// waits overlap; `turnSummaries` then puts names to the answers.
export async function turnWaitsFor(env: Env, rows: MatchIndexRow[]): Promise<Map<string, TableWait | null>> {
  const entries = await Promise.all(
    rows.map(async (row): Promise<[string, TableWait | null]> => {
      if (row.status !== 'active' || row.playerCount < 4) return [row.id, null];
      const stub = env.MATCH_DO.get(env.MATCH_DO.idFromName(row.id));
      const result = await withTimeout<MatchResult<TableWait | null>>(stub.getTurn(), TURN_LOOKUP_MS);
      return [row.id, result?.ok ? result.value : null];
    })
  );
  return new Map(entries);
}

// Each row's turn as the viewer sees it, from `turnWaitsFor`'s answers.
export function turnSummaries(
  waits: Map<string, TableWait | null>,
  viewerId: string,
  nameOf: (playerId: string) => string
): Map<string, TurnSummary | null> {
  return new Map(
    [...waits].map(([id, wait]): [string, TurnSummary | null] => [
      id,
      wait === null
        ? null
        : { kind: wait.kind, yours: wait.playerIds.includes(viewerId), waitingOn: wait.playerIds.map(nameOf) },
    ])
  );
}
