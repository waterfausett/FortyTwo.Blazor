// What one completed match adds to each human's lifetime stats (the Profile's Stats section). The
// Worker writes one row per human when the match is won (apps/worker/src/stats.ts) and adds them
// up when a player asks. Only filed hands count: a hand is filed under the team that took it as
// soon as it's decided (matchEngine.ts's playDomino), so they are exactly the decided hands.
import { Bid } from './bid';
import { isBot } from './botIds';
import { gameValue, type Game } from './game';
import type { MatchState } from './matchEngine';
import { isLow, Suit } from './suit';
import { teamForPosition, type Teams } from './teams';

// The trumps a winning bid can name, for a player's favorite. Every Low variant counts as Low. In
// ascending order, so a tie for favorite goes to the later (higher) one.
export const TRUMP_KEYS = ['low', 'followMe', 'blanks', 'aces', 'deuces', 'threes', 'fours', 'fives', 'sixes'] as const;
export type TrumpKey = (typeof TRUMP_KEYS)[number];
export type TrumpCounts = Record<TrumpKey, number>;

export const NO_TRUMPS: TrumpCounts = { low: 0, followMe: 0, blanks: 0, aces: 0, deuces: 0, threes: 0, fours: 0, fives: 0, sixes: 0 };

const SUIT_KEYS: Partial<Record<Suit, TrumpKey>> = {
  [Suit.None]: 'followMe',
  [Suit.Blanks]: 'blanks',
  [Suit.Aces]: 'aces',
  [Suit.Deuces]: 'deuces',
  [Suit.Threes]: 'threes',
  [Suit.Fours]: 'fours',
  [Suit.Fives]: 'fives',
  [Suit.Sixes]: 'sixes',
};

export function trumpKeyOf(trump: Suit | null | undefined): TrumpKey | null {
  if (trump === null || trump === undefined) return null;
  return isLow(trump) ? 'low' : (SUIT_KEYS[trump] ?? null);
}

export interface PlayerMatchStats {
  playerId: string;
  partnerId: string;
  // Any seat at the table held a bot.
  withBots: boolean;
  // Filed hands they played themselves: holding the seat, and making their own bid. A match's
  // result counts for them only from MIN_HANDS_FOR_RESULT up (the Worker's stats queries).
  handsPlayed: number;
  won: boolean;
  // Marks their team took.
  marksWon: number;
  // Hands they were the high bidder on, and how many of those their team made.
  bidsWon: number;
  bidsMade: number;
  // Their winning points bids (30-42), for an average; winning bids of a mark or more (42 and up)
  // are marks bids, so 42 counts in both.
  pointsBidTotal: number;
  pointsBidCount: number;
  marksBids: number;
  // The trump named on each of their winning bids.
  trumps: TrumpCounts;
}

// A player who took over a seat late must have played this many hands for the win or loss to count.
export const MIN_HANDS_FOR_RESULT = 3;

export function matchStatsFor(match: MatchState): PlayerMatchStats[] {
  if (match.winningTeam === null) return [];

  const withBots = match.hadBots ?? match.players.some((p) => isBot(p.playerId));
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
        handsPlayed: 0,
        won: match.winningTeam === team,
        marksWon: 0,
        bidsWon: 0,
        bidsMade: 0,
        pointsBidTotal: 0,
        pointsBidCount: 0,
        marksBids: 0,
        trumps: { ...NO_TRUMPS },
      };

      for (const { game, wonBy } of filed) {
        if (wonBy === team) stats.marksWon += gameValue(game) ?? 0;
        const own = game.hands.find((h) => h.playerId === player.playerId);
        if (own === undefined || own.autoBid) continue;
        stats.handsPlayed++;
        if (game.biddingPlayerId !== player.playerId) continue;
        const bid = own.bid;
        if (bid === null || bid === Bid.Pass) continue;

        stats.bidsWon++;
        if (wonBy === team) stats.bidsMade++;
        if (bid <= Bid.FortyTwo) {
          stats.pointsBidTotal += bid;
          stats.pointsBidCount++;
        }
        if (bid >= Bid.FortyTwo) stats.marksBids++;
        const trump = trumpKeyOf(game.trump);
        if (trump) stats.trumps[trump]++;
      }
      return stats;
    });
}
