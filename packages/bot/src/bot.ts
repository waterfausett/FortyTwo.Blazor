// The shipped bot: BidNet bidding through the same rules as Python's FastBidder, and the play
// network's best Q (decisions.ts). Stateless: trump is recomputed from the table (it's always the
// trump that justified the winning bid), so nothing has to survive between Durable Object alarms.
// `explain` is the same decisions with their numbers, for a human's hint (explain.ts).
import type { Hint } from '@fortytwo/api-types';
import type { Bid, Domino, MatchState, Suit } from '@fortytwo/rules';
import { createDecider } from './decisions';
import { explainWith } from './explain';
import type { BotWeights } from './weights';

export { legalPlays } from './legal';

export interface Bot {
  decideBid(match: MatchState, playerId: string): Bid;
  decideTrump(match: MatchState, playerId: string): Suit;
  decideDomino(match: MatchState, playerId: string): Domino;
  explain(match: MatchState, playerId: string): Hint;
}

export function createBot(w: BotWeights): Bot {
  const d = createDecider(w);
  return {
    decideBid: (match, playerId) => d.bid(match, playerId).decision.bid as Bid,
    decideTrump: (match, playerId) => d.trumps(match, playerId)[0].trump,
    decideDomino(match, playerId) {
      const plays = d.plays(match, playerId);
      let best = plays[0];
      for (const p of plays) if (p.q !== null && best.q !== null && p.q > best.q) best = p;
      return best.domino;
    },
    explain: (match, playerId) => explainWith(d, match, playerId),
  };
}
