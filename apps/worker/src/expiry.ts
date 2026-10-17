// The daily sweep (index.ts's `scheduled`, on wrangler.toml's cron) that deletes active matches
// nobody has touched in MATCH_IDLE_DAYS: tables that never filled and games everyone walked away
// from. D1 says which matches look idle; each match's DO has the final say (MatchDO.expire).
import type { Env } from './index';
import type { ExpireOutcome } from './matchDO';
import { deleteFromLobbyIndex, syncLobbyIndex } from './lobby';

export const MATCH_IDLE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
// Bounds one run's work; whatever is left over waits for tomorrow's.
const BATCH_SIZE = 100;
const MAX_BATCHES = 10;

export interface ExpirySummary {
  expired: number;
  refreshed: number;
  orphaned: number;
  failed: number;
}

export type ExpireOne = (matchId: string, cutoff: string) => Promise<ExpireOutcome>;

export async function expireIdleMatches(
  env: Env,
  now: number,
  expireOne: ExpireOne = (matchId, cutoff) => env.MATCH_DO.get(env.MATCH_DO.idFromName(matchId)).expire(cutoff)
): Promise<ExpirySummary> {
  // updated_on holds ISO-8601 UTC strings, so comparing strings compares times.
  const cutoff = new Date(now - MATCH_IDLE_DAYS * DAY_MS).toISOString();
  const summary: ExpirySummary = { expired: 0, refreshed: 0, orphaned: 0, failed: 0 };
  // A match that failed keeps its row, which would match the next batch's query again - so every
  // id already tried this run is excluded, as one JSON param (D1 caps bound parameters at 100).
  const tried: string[] = [];

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM matches
       WHERE status = 'active' AND updated_on < ? AND id NOT IN (SELECT value FROM json_each(?))
       ORDER BY updated_on LIMIT ?`
    )
      .bind(cutoff, JSON.stringify(tried), BATCH_SIZE)
      .all<{ id: string }>();
    if (results.length === 0) break;

    for (const { id } of results) {
      tried.push(id);
      try {
        const result = await expireOne(id, cutoff);
        if (result.outcome === 'fresh') {
          await syncLobbyIndex(env.DB, result.match);
          summary.refreshed++;
        } else {
          await deleteFromLobbyIndex(env.DB, id);
          summary[result.outcome === 'expired' ? 'expired' : 'orphaned']++;
        }
      } catch (error) {
        console.error(`Failed to expire match ${id}`, error);
        summary.failed++;
      }
    }
  }

  console.log('Match expiry sweep', summary);
  return summary;
}
