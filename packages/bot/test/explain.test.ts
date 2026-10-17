// A hint is the bot explaining itself: its suggestion must be the bot's own decision, it may only
// read the asker's own hand, and it shows the options around that decision.
import { describe, expect, it } from 'vitest';
import {
  Bid, Suit, ValidationError, createDomino, createMatch, gameWinningTeam, placeBid, setTrump, takeSeat,
  type Domino, type MatchState,
} from '@fortytwo/rules';
import { CLOSE_GAP, assertCanHint, createBot, explainWith, type Decider } from '../src/index';
import { fixtureHands, fixtureWeights } from './fixtures';
import { PLAYERS, applyStep, startHand } from './replay';

const w = fixtureWeights();
const bot = createBot(w);

// Deals the remaining dominoes of everyone but `playerId` back out at random, each keeping their
// count: the hidden information changes, the public play and `playerId`'s hand don't.
function reshuffleOthers(match: MatchState, playerId: string, seed: number): MatchState {
  const hands = match.currentGame.hands;
  const pool = hands.filter((h) => h.playerId !== playerId).flatMap((h) => h.dominoes);
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  let k = 0;
  const dealt = hands.map((h) =>
    h.playerId === playerId ? h : { ...h, dominoes: pool.slice(k, (k += h.dominoes.length)) }
  );
  return { ...match, currentGame: { ...match.currentGame, hands: dealt } };
}

describe('explain agrees with the bot', () => {
  it("suggests exactly the bot's bid, trump and domino at every fixture decision", () => {
    const counts = { bid: 0, trump: 0, play: 0 };
    for (const h of fixtureHands()) {
      let match = startHand(h);
      for (const s of h.steps) {
        const id = PLAYERS[s.seat];
        if (!s.scripted && gameWinningTeam(match.currentGame) === null) {
          const hint = bot.explain(match, id);
          if (s.phase === 'bid') {
            expect(hint.kind).toBe('bid');
            if (hint.kind === 'bid') expect(hint.suggestion.bid).toBe(bot.decideBid(match, id));
            counts.bid++;
          } else if (s.phase === 'trump') {
            expect(hint.kind).toBe('trump');
            if (hint.kind === 'trump') expect(hint.suggestion.trump).toBe(bot.decideTrump(match, id));
            counts.trump++;
          } else {
            expect(hint.kind).toBe('play');
            if (hint.kind === 'play') expect(hint.dominoes[0].domino.id).toBe(bot.decideDomino(match, id).id);
            counts.play++;
          }
        }
        match = applyStep(match, s);
      }
    }
    expect(counts.bid).toBeGreaterThan(300);
    expect(counts.trump).toBeGreaterThan(50);
    expect(counts.play).toBeGreaterThan(1000);
  });
});

describe('explain reads only the asker’s own hand', () => {
  it('gives the same hint whatever the other three hold, for a bid, a trump and a play', () => {
    const seen = new Set<string>();
    for (const h of fixtureHands().slice(0, 40)) {
      let match = startHand(h);
      for (const s of h.steps) {
        const id = PLAYERS[s.seat];
        if (!s.scripted && gameWinningTeam(match.currentGame) === null && !seen.has(s.phase)) {
          const hint = bot.explain(match, id);
          for (const seed of [1, 2, 3]) expect(bot.explain(reshuffleOthers(match, id, seed), id)).toEqual(hint);
        }
        if (!s.scripted && s.phase === 'play' && match.currentGame.tricks.length >= 2) seen.add('play');
        if (!s.scripted && s.phase !== 'play') seen.add(s.phase);
        match = applyStep(match, s);
      }
    }
    expect([...seen].sort()).toEqual(['bid', 'play', 'trump']);
  });
});

// Real matches at each phase, for the rules-facing checks; the fake decider below supplies the numbers.
function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}
function bidding(): MatchState {
  let m = createMatch('p1', 'bots');
  m = takeSeat(m, 'p2', 1);
  m = takeSeat(m, 'p3', 2);
  return takeSeat(m, 'p4', 3, deck());
}
function trumpCall(): MatchState {
  let m = bidding();
  const first = m.currentGame.currentPlayerId!;
  m = placeBid(m, first, Bid.Thirty);
  for (let i = 0; i < 3; i++) m = placeBid(m, m.currentGame.currentPlayerId!, Bid.Pass);
  return m;
}
function playing(): MatchState {
  const m = trumpCall();
  return setTrump(m, m.currentGame.currentPlayerId!, Suit.Sixes);
}

function fakeDecider(over: Partial<Decider>): Decider {
  const unused = () => { throw new Error('not used'); };
  return { bid: unused, trumps: unused, plays: unused, ...over };
}
const opt = (bid: number, trump: number, pMake: number) => ({ bid, trump, pMake });

describe('bid hints', () => {
  const legal = [Bid.Pass, 30, 31, 32, 33, 34];
  const options = [opt(30, 6, 0.9), opt(30, 5, 0.95), opt(31, 6, 0.8), opt(32, 6, 0.7), opt(33, 6, 0.6), opt(34, 6, 0.5)];
  const hintFor = (bid: number) => {
    const m = bidding();
    const d = fakeDecider({
      bid: () => ({ decision: { bid, trump: bid === 0 ? null : 6, pMake: bid === 0 ? null : 0.7 }, options, legal }),
    });
    return explainWith(d, m, m.currentGame.currentPlayerId!);
  };

  it('shows the suggested bid between its neighbours, each in its best trump', () => {
    const hint = hintFor(32);
    expect(hint.kind === 'bid' && hint.options.map((o) => o.bid)).toEqual([31, 32, 33]);
    expect(hint.kind === 'bid' && hint.options[1]).toEqual({ bid: 32, trump: 6, pMake: 0.7 });
  });

  it('keeps three rows at either end of the bids', () => {
    const low = hintFor(30);
    expect(low.kind === 'bid' && low.options.map((o) => o.bid)).toEqual([30, 31, 32]);
    expect(low.kind === 'bid' && low.options[0]).toEqual({ bid: 30, trump: 5, pMake: 0.95 });
    const high = hintFor(34);
    expect(high.kind === 'bid' && high.options.map((o) => o.bid)).toEqual([32, 33, 34]);
  });

  it('shows the lowest bids when the bot would pass, so the player sees why', () => {
    const hint = hintFor(Bid.Pass);
    expect(hint.kind === 'bid' && hint.suggestion).toEqual({ bid: 0, trump: null, pMake: null });
    expect(hint.kind === 'bid' && hint.options.map((o) => o.bid)).toEqual([30, 31, 32]);
  });

  it('names no trump for a Plunge, which the partner names', () => {
    const m = bidding();
    const d = fakeDecider({
      bid: () => ({ decision: { bid: Bid.Plunge, trump: -1, pMake: 0.8 }, options: [opt(Bid.Plunge, -1, 0.8)], legal: [Bid.Plunge] }),
    });
    const hint = explainWith(d, m, m.currentGame.currentPlayerId!);
    expect(hint.kind === 'bid' && hint.suggestion).toEqual({ bid: Bid.Plunge, trump: null, pMake: 0.8 });
  });

  it('shows a forced bid with no option as a row without numbers', () => {
    const m = bidding();
    const d = fakeDecider({ bid: () => ({ decision: { bid: 30, trump: null, pMake: null }, options: [], legal: [30] }) });
    const hint = explainWith(d, m, m.currentGame.currentPlayerId!);
    expect(hint.kind === 'bid' && hint.options).toEqual([{ bid: 30, trump: null, pMake: null }]);
  });
});

describe('trump hints', () => {
  it('suggests the first-ranked trump and lists the top three', () => {
    const m = trumpCall();
    const ranked = [{ trump: 6, pMake: 0.9 }, { trump: 5, pMake: 0.8 }, { trump: 4, pMake: 0.7 }, { trump: 3, pMake: 0.6 }];
    const hint = explainWith(fakeDecider({ trumps: () => ranked }), m, m.currentGame.currentPlayerId!);
    expect(hint).toEqual({ kind: 'trump', suggestion: ranked[0], options: ranked.slice(0, 3) });
  });
});

describe('play hints', () => {
  const d = (...q: (number | null)[]) => (m: MatchState) =>
    fakeDecider({ plays: () => m.currentGame.hands.find((h) => h.playerId === m.currentGame.currentPlayerId)!.dominoes
      .slice(0, q.length).map((domino, i) => ({ domino, q: q[i] })) });

  it('rates every legal domino by its gap to the best, best first', () => {
    const m = playing();
    const hint = explainWith(d(0.2, 0.62, 0.57, 0.62)(m), m, m.currentGame.currentPlayerId!);
    if (hint.kind !== 'play') throw new Error('expected a play hint');
    expect(hint.dominoes.map((r) => r.rating)).toEqual(['best', 'best', 'close', 'weaker']);
    expect(hint.dominoes[2].gap).toBeCloseTo(0.05);
    expect(hint.dominoes[3].gap).toBeCloseTo(0.42);
    expect(hint.dominoes[2].gap).toBeLessThan(CLOSE_GAP);
  });

  it('rates a lone legal domino best, with nothing to compare', () => {
    const m = playing();
    const hint = explainWith(d(null)(m), m, m.currentGame.currentPlayerId!);
    expect(hint.kind === 'play' && hint.dominoes.map((r) => [r.rating, r.marks, r.gap])).toEqual([['best', 0, 0]]);
  });
});

describe('assertCanHint', () => {
  it("refuses anyone whose turn it isn't", () => {
    const m = bidding();
    const other = ['p1', 'p2', 'p3', 'p4'].find((p) => p !== m.currentGame.currentPlayerId)!;
    expect(() => assertCanHint(m, other)).toThrow(ValidationError);
    expect(() => assertCanHint(m, m.currentGame.currentPlayerId!)).not.toThrow();
  });

  it('refuses once the hand is decided', () => {
    const h = fixtureHands().find((x) => x.steps.filter((s) => s.phase === 'play').length < 24)!;
    let match = startHand(h);
    for (const s of h.steps) {
      if (gameWinningTeam(match.currentGame) !== null) break;
      match = applyStep(match, s);
    }
    expect(gameWinningTeam(match.currentGame)).not.toBeNull();
    const turn = match.currentGame.currentPlayerId!;
    expect(() => assertCanHint(match, turn)).toThrow(/decided/i);
  });
});
