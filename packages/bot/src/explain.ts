// A hint: what the bot would do in a player's seat, and the numbers behind it, for a human in a
// practice match (#76). Built on the bot's own decisions (decisions.ts), so the suggestion is
// always exactly the bot's move. Everything comes from the asker's own hand and the public play -
// buildView and bidTable read nothing else (test/explain.test.ts proves it).
import type { BidSuggestion, Hint, PlayRating } from '@fortytwo/api-types';
import { Bid, ValidationError, gameWinningTeam, type MatchState } from '@fortytwo/rules';
import type { Option } from './bidding';
import type { Decider } from './decisions';

// Below this many expected marks short of the best, a domino is "close" rather than "weaker".
export const CLOSE_GAP = 0.1;
// Rows a bid or trump hint lists.
const ROWS = 3;

// A hint is for the asker's own turn to bid, name trump or play, while the hand is still open.
export function assertCanHint(match: MatchState, playerId: string): void {
  const game = match.currentGame;
  if (game.currentPlayerId !== playerId) throw new ValidationError('Not your turn', 'Hints are for your own turn.');
  if (gameWinningTeam(game) !== null) throw new ValidationError('Hand decided', 'This hand is already decided.');
}

export function explainWith(d: Decider, match: MatchState, playerId: string): Hint {
  assertCanHint(match, playerId);
  const game = match.currentGame;
  if (game.hands.some((h) => h.bid === null)) return bidHint(d, match, playerId);
  if (game.trump === null) {
    const ranked = d.trumps(match, playerId);
    return { kind: 'trump', suggestion: ranked[0], options: ranked.slice(0, ROWS) };
  }
  return playHint(d, match, playerId);
}

// The partner names a Plunge's trump, so the bid has none of its own.
function suggestion(o: { bid: number; trump: number | null; pMake: number | null }): BidSuggestion {
  return { bid: o.bid, trump: o.bid === Bid.Plunge ? null : o.trump, pMake: o.pMake };
}

// The suggested bid between its neighbours (or the lowest bids, when the bot would pass), each in
// the trump that makes it likeliest - the same best-per-bid choose_bid weighs.
function bidHint(d: Decider, match: MatchState, playerId: string): Hint {
  const { decision, options, legal } = d.bid(match, playerId);
  const best = new Map<number, Option>();
  for (const o of options) {
    const cur = best.get(o.bid);
    if (cur === undefined || o.pMake > cur.pMake) best.set(o.bid, o);
  }
  const rows = legal
    .filter((b) => b !== Bid.Pass)
    .sort((a, b) => a - b)
    .map((b) => (best.has(b) ? suggestion(best.get(b)!) : { bid: b, trump: null, pMake: null }));
  const at = rows.findIndex((r) => r.bid === decision.bid);
  const start = at < 0 ? 0 : Math.max(0, Math.min(at - 1, rows.length - ROWS));
  return { kind: 'bid', suggestion: suggestion(decision), options: rows.slice(start, start + ROWS) };
}

function playHint(d: Decider, match: MatchState, playerId: string): Hint {
  const plays = d.plays(match, playerId);
  if (plays.some((p) => p.q === null)) {
    return { kind: 'play', dominoes: plays.map((p) => ({ domino: p.domino, marks: 0, gap: 0, rating: 'best' })) };
  }
  const top = Math.max(...plays.map((p) => p.q!));
  const rated = plays.map((p): PlayRating => {
    const gap = top - p.q!;
    return { domino: p.domino, marks: p.q!, gap, rating: gap === 0 ? 'best' : gap < CLOSE_GAP ? 'close' : 'weaker' };
  });
  // Stable, so tied dominoes keep hand order and the first is the one the bot would play.
  return { kind: 'play', dominoes: rated.sort((a, b) => a.gap - b.gap) };
}
