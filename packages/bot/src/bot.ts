// The shipped bot: BidNet bidding through the same rules as Python's FastBidder, and the play
// network's best Q. Stateless: trump is recomputed from the table (it's always the trump that
// justified the winning bid), so nothing has to survive between Durable Object alarms.
import {
  Bid, Suit, availableBids, availableTrumps, gameWinningTeam, isOfSuit, type Domino, type Game, type MatchState,
} from '@fortytwo/rules';
import { bidTable, chooseBid, optionsFromTable } from './bidding';
import { toIndex } from './dominoes';
import { OBS_DIM, encodeCandidates } from './encode';
import { scoreCandidates } from './mlp';
import { buildView, seatOf } from './view';
import type { BotWeights } from './weights';

export interface Bot {
  decideBid(match: MatchState, playerId: string): Bid;
  decideTrump(match: MatchState, playerId: string): Suit;
  decideDomino(match: MatchState, playerId: string): Domino;
}

const handOf = (game: Game, playerId: string) => game.hands.find((h) => h.playerId === playerId)!.dominoes;

// Follow suit: holding the led suit, you must play it (validation.assertValidDomino).
export function legalPlays(game: Game, playerId: string): Domino[] {
  const hand = handOf(game, playerId);
  const suit = game.currentTrick.suit;
  if (suit === null) return hand;
  const following = hand.filter((d) => isOfSuit(d, suit, game.trump));
  return following.length ? following : hand;
}

function firstMax<T>(items: T[], score: (t: T) => number): T {
  let best = items[0];
  for (const t of items) if (score(t) > score(best)) best = t;
  return best;
}

export function createBot(w: BotWeights): Bot {
  const cfg = { makeThreshold: w.manifest.makeThreshold, overbidPartnerThreshold: w.manifest.overbidPartnerThreshold };
  const table = (game: Game, playerId: string) => bidTable(w, handOf(game, playerId).map(toIndex));

  return {
    decideBid(match, playerId) {
      const game = match.currentGame;
      const seat = seatOf(match, playerId);
      const legal = availableBids(game, playerId);
      const ctx = {
        legal,
        partnerHolds: game.biddingPlayerId !== null && seatOf(match, game.biddingPlayerId) === (seat + 2) % 4,
        lastToBid: game.hands.every((h) => h.playerId === playerId || h.bid !== null),
      };
      return chooseBid(optionsFromTable(table(game, playerId), legal), ctx, cfg).bid as Bid;
    },

    decideTrump(match, playerId) {
      const game = match.currentGame;
      const legal = availableTrumps(game);
      const t = table(game, playerId);
      if (game.bid === Bid.Plunge && game.biddingPlayerId !== playerId) {
        return firstMax(legal, (s) => t.high[s === Suit.None ? 7 : s]);
      }
      const atBid = optionsFromTable(t, [game.bid!]).filter((o) => legal.includes(o.trump as Suit));
      return (atBid.length ? firstMax(atBid, (o) => o.pMake).trump : legal[0]) as Suit;
    },

    decideDomino(match, playerId) {
      const game = match.currentGame;
      const legal = legalPlays(game, playerId);
      if (legal.length === 1 || gameWinningTeam(game) !== null) return legal[0];
      const rows = encodeCandidates(buildView(match, playerId), legal.map(toIndex));
      const q = scoreCandidates(w.play, OBS_DIM, rows);
      return legal[q.indexOf(Math.max(...q))];
    },
  };
}
