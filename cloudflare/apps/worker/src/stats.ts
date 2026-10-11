// Each player's lifetime stats (migrations/0009_player_match_stats.sql): written once per human
// when a match is won (MatchDO), added up when they open their Profile (GET /api/users/stats).
// Reading costs about two rows per game the player has finished - the totals, then the partners.
import { isBot, matchStatsFor, type MatchState } from '@fortytwo/rules';
import type { BestPartner, PlayerStats, StatsSummary } from '@fortytwo/api-types';
import type { Env } from './index';
import { publicUsers } from './users/publicUsers';

export const BEST_PARTNER_MIN_GAMES = 3;
// For a partner whose name can't be looked up just now (Auth0 unreachable) or at all: neutral, since
// the first is usually a current player.
const UNKNOWN_PARTNER_NAME = 'Unknown player';

// One row per human. INSERT OR IGNORE: writing a match twice changes nothing.
export async function recordMatchStats(db: D1Database, match: MatchState): Promise<void> {
  const rows = matchStatsFor(match);
  if (rows.length === 0) return;
  await db.batch(
    rows.map((r) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO player_match_stats (match_id, player_id, partner_id, with_bots, won, marks_won,
             bids_won, bids_made, points_bid_total, points_bid_count, marks_bids, completed_on)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
        )
        .bind(
          match.id, r.playerId, r.partnerId, r.withBots ? 1 : 0, r.won ? 1 : 0, r.marksWon,
          r.bidsWon, r.bidsMade, r.pointsBidTotal, r.pointsBidCount, r.marksBids, match.updatedOn
        )
    )
  );
}

interface Totals {
  played: number;
  won: number;
  marksWon: number;
  bidsWon: number;
  bidsMade: number;
  pointsBidTotal: number;
  pointsBidCount: number;
  marksBids: number;
}

interface PartnerRecord {
  partnerId: string;
  played: number;
  won: number;
}

const NO_TOTALS: Totals = { played: 0, won: 0, marksWon: 0, bidsWon: 0, bidsMade: 0, pointsBidTotal: 0, pointsBidCount: 0, marksBids: 0 };

function addTotals(a: Totals, b: Totals): Totals {
  return {
    played: a.played + b.played,
    won: a.won + b.won,
    marksWon: a.marksWon + b.marksWon,
    bidsWon: a.bidsWon + b.bidsWon,
    bidsMade: a.bidsMade + b.bidsMade,
    pointsBidTotal: a.pointsBidTotal + b.pointsBidTotal,
    pointsBidCount: a.pointsBidCount + b.pointsBidCount,
    marksBids: a.marksBids + b.marksBids,
  };
}

// Highest win rate over enough games, then more games, then id - so the same rows always pick
// the same partner. Bots never count, nor a partner the player has never won with.
function bestOf(records: PartnerRecord[]): PartnerRecord | null {
  const eligible = records.filter(
    (r) => !isBot(r.partnerId) && r.partnerId !== '' && r.played >= BEST_PARTNER_MIN_GAMES && r.won > 0
  );
  eligible.sort(
    (a, b) => b.won / b.played - a.won / a.played || b.played - a.played || a.partnerId.localeCompare(b.partnerId)
  );
  return eligible[0] ?? null;
}

// Each partner's record across both bot groups, for All.
function mergePartners(records: PartnerRecord[]): PartnerRecord[] {
  const byId = new Map<string, PartnerRecord>();
  for (const r of records) {
    const seen = byId.get(r.partnerId);
    byId.set(r.partnerId, seen ? { ...seen, played: seen.played + r.played, won: seen.won + r.won } : { ...r });
  }
  return [...byId.values()];
}

function summarize(t: Totals, best: BestPartner | null): StatsSummary {
  return {
    played: t.played,
    won: t.won,
    lost: t.played - t.won,
    marksWon: t.marksWon,
    bidsWon: t.bidsWon,
    bidsMade: t.bidsMade,
    bidsSet: t.bidsWon - t.bidsMade,
    averagePointsBid: t.pointsBidCount === 0 ? null : Math.round((t.pointsBidTotal / t.pointsBidCount) * 10) / 10,
    marksBids: t.marksBids,
    bestPartner: best,
  };
}

export async function readPlayerStats(env: Env, playerId: string): Promise<PlayerStats> {
  const [totalsResult, partnersResult] = await env.DB.batch([
    env.DB.prepare(
      `SELECT with_bots AS withBots, COUNT(*) AS played, SUM(won) AS won, SUM(marks_won) AS marksWon,
         SUM(bids_won) AS bidsWon, SUM(bids_made) AS bidsMade, SUM(points_bid_total) AS pointsBidTotal,
         SUM(points_bid_count) AS pointsBidCount, SUM(marks_bids) AS marksBids
       FROM player_match_stats WHERE player_id = ? GROUP BY with_bots`
    ).bind(playerId),
    env.DB.prepare(
      `SELECT partner_id AS partnerId, with_bots AS withBots, COUNT(*) AS played, SUM(won) AS won
       FROM player_match_stats WHERE player_id = ? GROUP BY partner_id, with_bots`
    ).bind(playerId),
  ]);
  const totals = totalsResult.results as (Totals & { withBots: number })[];
  const partners = partnersResult.results as (PartnerRecord & { withBots: number })[];

  const humansTotals = totals.find((t) => t.withBots === 0) ?? NO_TOTALS;
  const botsTotals = totals.find((t) => t.withBots === 1) ?? NO_TOTALS;
  const best = {
    all: bestOf(mergePartners(partners)),
    humansOnly: bestOf(partners.filter((p) => p.withBots === 0)),
    withBots: bestOf(partners.filter((p) => p.withBots === 1)),
  };

  const ids = [...new Set(Object.values(best).flatMap((b) => (b ? [b.partnerId] : [])))];
  const { users } = ids.length > 0 ? await publicUsers(env, ids) : { users: [] };
  const partnerOf = (record: PartnerRecord | null): BestPartner | null =>
    record && {
      user: users.find((u) => u.user_id === record.partnerId) ?? { user_id: record.partnerId, displayName: UNKNOWN_PARTNER_NAME },
      won: record.won,
      lost: record.played - record.won,
    };

  return {
    all: summarize(addTotals(humansTotals, botsTotals), partnerOf(best.all)),
    humansOnly: summarize(humansTotals, partnerOf(best.humansOnly)),
    withBots: summarize(botsTotals, partnerOf(best.withBots)),
  };
}
