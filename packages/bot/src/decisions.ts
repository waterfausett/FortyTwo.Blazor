// The bot's three decisions with the numbers behind them, shared by the bot (bot.ts), which acts
// on the decision alone, and by hints (explain.ts), which show the numbers too - so a hint can
// never disagree with what a bot in that seat would do.
import {
  Bid, Suit, availableBids, availableTrumps, gameWinningTeam, lowAllowedIfWon, type Domino, type Game, type MatchState,
} from '@fortytwo/rules';
import { bidTable, chooseBid, optionsFromTable, type BidDecision, type Option } from './bidding';
import { toIndex } from './dominoes';
import { OBS_DIM, encodeCandidates } from './encode';
import { scoreCandidates } from './mlp';
import { buildView, seatOf } from './view';
import { legalPlays } from './legal';
import type { BotWeights } from './weights';

export interface Decider {
  // choose_bid's decision, the options it chose from, and the legal bids.
  bid(match: MatchState, playerId: string): { decision: BidDecision; options: Option[]; legal: Bid[] };
  // Every legal trump the bot would consider, best first; the first is the one it names. A tie
  // keeps option order, so the first is the same first maximum the bot always picked.
  trumps(match: MatchState, playerId: string): { trump: Suit; pMake: number | null }[];
  // Every legal domino in hand order, with its Q-value: expected hand marks for the player's team.
  // Null throughout when there's no inference to run (one legal domino, or the hand is decided).
  plays(match: MatchState, playerId: string): { domino: Domino; q: number | null }[];
}

const handOf = (game: Game, playerId: string) => game.hands.find((h) => h.playerId === playerId)!.dominoes;

// Highest pMake first. Array.prototype.sort is stable, so equal ones keep their order.
function bestFirst<T extends { pMake: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.pMake - a.pMake);
}

export function createDecider(w: BotWeights): Decider {
  const cfg = { makeThreshold: w.manifest.makeThreshold, overbidPartnerThreshold: w.manifest.overbidPartnerThreshold };
  const table = (game: Game, playerId: string) => bidTable(w, handOf(game, playerId).map(toIndex));

  return {
    bid(match, playerId) {
      const game = match.currentGame;
      const seat = seatOf(match, playerId);
      const legal = availableBids(game, playerId);
      const ctx = {
        legal,
        partnerHolds: game.biddingPlayerId !== null && seatOf(match, game.biddingPlayerId) === (seat + 2) % 4,
        lastToBid: game.hands.every((h) => h.playerId === playerId || h.bid !== null),
      };
      // Low's options only where the house rules would let this bidder name it.
      const options = optionsFromTable(table(game, playerId), legal, lowAllowedIfWon(game, playerId));
      return { decision: chooseBid(options, ctx, cfg), options, legal };
    },

    trumps(match, playerId) {
      const game = match.currentGame;
      const legal = availableTrumps(game);
      const t = table(game, playerId);
      if (game.bid === Bid.Plunge && game.biddingPlayerId !== playerId) {
        return bestFirst(legal.map((s) => ({ trump: s, pMake: t.high[s === Suit.None ? 7 : s] })));
      }
      const atBid = optionsFromTable(t, [game.bid!]).filter((o) => legal.includes(o.trump as Suit));
      return atBid.length
        ? bestFirst(atBid.map((o) => ({ trump: o.trump as Suit, pMake: o.pMake })))
        : [{ trump: legal[0], pMake: null }];
    },

    plays(match, playerId) {
      const game = match.currentGame;
      const legal = legalPlays(game, playerId);
      if (legal.length === 1 || gameWinningTeam(game) !== null) return legal.map((domino) => ({ domino, q: null }));
      const rows = encodeCandidates(buildView(match, playerId), legal.map(toIndex));
      const q = scoreCandidates(w.play, OBS_DIM, rows);
      return legal.map((domino, i) => ({ domino, q: q[i] }));
    },
  };
}
