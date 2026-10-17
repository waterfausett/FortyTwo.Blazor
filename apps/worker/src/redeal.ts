// A bid, and - under the redeal house rule - new hands when it was the fourth pass. One step, so
// the all-passed hand is never stored or broadcast, and a deck is only shuffled when it's dealt.
import { needsRedeal, placeBid, redeal, shuffledDominoOrder, type Bid, type MatchState } from '@fortytwo/rules';

export function bidAndMaybeRedeal(match: MatchState, playerId: string, bid: Bid): MatchState {
  const next = placeBid(match, playerId, bid);
  return needsRedeal(next) ? redeal(next, shuffledDominoOrder()) : next;
}
