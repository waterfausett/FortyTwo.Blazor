// What one completed match adds to each human's lifetime stats (the Profile's Stats section). The
// Worker writes one row per human when the match is won (apps/worker/src/stats.ts) and adds them
// up when a player asks. Only filed hands count: a hand is filed under the team that took it as
// soon as it's decided (matchEngine.ts's playDomino), so they are exactly the decided hands.
import { Bid } from './bid';
import { isBot } from './botIds';
import { gameValue, type Game } from './game';
import type { MatchState } from './matchEngine';
import { teamForPosition, type Teams } from './teams';

export interface PlayerMatchStats {
  playerId: string;
  partnerId: string;
  // Any seat at the table held a bot.
  withBots: boolean;
  won: boolean;
  // Marks their team took.
  marksWon: number;
  // Hands they were the high bidder on, and how many of those their team made.
  bidsWon: number;
  bidsMade: number;
  // Their winning points bids (30-42), for an average; bids of 84 and up are marks bids.
  pointsBidTotal: number;
  pointsBidCount: number;
  marksBids: number;
}

export function matchStatsFor(match: MatchState): PlayerMatchStats[] {
  if (match.winningTeam === null) return [];

  const withBots = match.players.some((p) => isBot(p.playerId));
  const filed = (Object.entries(match.games) as [string, Game[] | undefined][]).flatMap(([key, games]) =>
    (games ?? []).map((game) => ({ game, wonBy: Number(key) as Teams }))
  );

  return match.players
    .filter((player) => !isBot(player.playerId))
    .map((player) => {
      const team = teamForPosition(player.position);
      const partner = match.players.find((p) => p.playerId !== player.playerId && teamForPosition(p.position) === team);
      const stats: PlayerMatchStats = {
        playerId: player.playerId,
        partnerId: partner?.playerId ?? '',
        withBots,
        won: match.winningTeam === team,
        marksWon: 0,
        bidsWon: 0,
        bidsMade: 0,
        pointsBidTotal: 0,
        pointsBidCount: 0,
        marksBids: 0,
      };

      for (const { game, wonBy } of filed) {
        if (wonBy === team) stats.marksWon += gameValue(game) ?? 0;
        if (game.biddingPlayerId !== player.playerId) continue;
        const bid = game.hands.find((h) => h.playerId === player.playerId)?.bid ?? null;
        if (bid === null || bid === Bid.Pass) continue;

        stats.bidsWon++;
        if (wonBy === team) stats.bidsMade++;
        if (bid <= Bid.FortyTwo) {
          stats.pointsBidTotal += bid;
          stats.pointsBidCount++;
        } else {
          stats.marksBids++;
        }
      }
      return stats;
    });
}
