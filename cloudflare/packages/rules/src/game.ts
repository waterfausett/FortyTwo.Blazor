import { Bid } from './bid';
import { Hand } from './hand';
import { Suit } from './suit';
import { Teams } from './teams';
import { Trick, trickValue } from './trick';

export interface Game {
  id: string;
  name: string;
  firstActionBy: string | null;
  bid: Bid | null;
  biddingPlayerId: string | null;
  trump: Suit | null;
  currentPlayerId: string | null;
  hands: Hand[];
  currentTrick: Trick;
  tricks: Trick[];
}

// Port of C# `Game.Value`.
export function gameValue(g: Game): number | null {
  if (g.biddingPlayerId == null) return null;

  const bid = g.hands.find((x) => x.playerId === g.biddingPlayerId)?.bid;
  return bid == null ? null : bid <= 42 ? 1 : Math.floor(bid / 42);
}

// Port of C# `Game.WinningTeam`. Kept structurally faithful to the original getter
// (same four-way ternary shape) rather than flattened, so it stays auditable line-by-line
// against FortyTwo/Shared/Models/Game.cs.
export function gameWinningTeam(g: Game): Teams | null {
  if (g.biddingPlayerId == null) return null;

  const biddingTeamId = g.hands.find((x) => x.playerId === g.biddingPlayerId)?.team ?? null;
  const otherTeamId = g.hands.find((x) => x.team !== biddingTeamId)?.team ?? null;

  // teamPoints only has an entry for a team once they've won at least one trick
  // (mirrors C#'s `Tricks.GroupBy(t => t.Team).ToDictionary(...)`: a team absent from
  // Tricks is simply absent as a key, not present with value 0).
  const teamPoints = new Map<Teams, number>();
  for (const t of g.tricks) {
    if (t.team == null) continue;
    teamPoints.set(t.team, (teamPoints.get(t.team) ?? 0) + trickValue(t));
  }

  const adjustedBid = (g.bid as number) % 42 === 0 ? 42 : (g.bid as number);

  return g.trump === Suit.Low
    ? biddingTeamId != null && teamPoints.has(biddingTeamId)
      ? otherTeamId
      : g.tricks.length === 7
        ? biddingTeamId
        : null
    : biddingTeamId != null && teamPoints.has(biddingTeamId) && (teamPoints.get(biddingTeamId) as number) >= adjustedBid
      ? biddingTeamId
      : otherTeamId != null && teamPoints.has(otherTeamId) && (teamPoints.get(otherTeamId) as number) > 42 - adjustedBid
        ? otherTeamId
        : null;
}
