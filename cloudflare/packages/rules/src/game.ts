import { Bid, pointsToMakeBid } from './bid';
import { Hand } from './hand';
import type { HouseRules } from './houseRules';
import { Suit, isLow } from './suit';
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
  // When the hand was dealt; absent on hands from before it was recorded. A player on autopilot
  // since then has been away for the whole hand (live.ts).
  dealtOn?: string;
  // The match's house rules (houseRules.ts), copied onto each hand dealt; absent means defaults.
  rules?: HouseRules;
  // This hand was dealt again because everyone passed (house rule `allPass: 'redeal'`).
  redealt?: true;
  // The winning bid was made by a player whose three opponents had all passed - they were forced
  // to bid. Set by placeBid; read by the 'forcedOnly' Low house rule.
  forcedBid?: true;
}

// Marks the hand is worth: 1 for a points bid (up to 42), otherwise one per 42 bid. Null until
// someone has bid.
export function gameValue(g: Game): number | null {
  if (g.biddingPlayerId == null) return null;

  const bid = g.hands.find((x) => x.playerId === g.biddingPlayerId)?.bid;
  return bid == null ? null : bid <= 42 ? 1 : Math.floor(bid / 42);
}

// The team that has decided the hand, or null while it's still open. The bidders win by making
// their bid, the other team by taking enough points that the bid can't be made. On a Low trump the
// bidders must lose every trick instead, so they lose on the first trick they take.
export function gameWinningTeam(g: Game): Teams | null {
  if (g.biddingPlayerId == null) return null;

  const biddingTeamId = g.hands.find((x) => x.playerId === g.biddingPlayerId)?.team ?? null;
  const otherTeamId = g.hands.find((x) => x.team !== biddingTeamId)?.team ?? null;

  // A team has an entry only once it has taken a trick.
  const teamPoints = new Map<Teams, number>();
  for (const t of g.tricks) {
    if (t.team == null) continue;
    teamPoints.set(t.team, (teamPoints.get(t.team) ?? 0) + trickValue(t));
  }

  // Marks bids and Plunge all need every point.
  const adjustedBid = pointsToMakeBid(g.bid as Bid);

  return isLow(g.trump)
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
