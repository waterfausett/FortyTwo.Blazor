import { describe, it, expect } from 'vitest';
import { availableBids, availableTrumps, assertValidBid, assertValidTrump } from './validation';
import { Suit } from './suit';
import { ValidationError } from './errors';
import { Bid } from './bid';
import { createDomino } from './domino';
import { Game } from './game';
import { Hand } from './hand';
import { Teams } from './teams';
import { createTrick } from './trick';

// A hand with `doubles` doubles, padded out to seven dominoes with non-doubles.
function hand(playerId: string, doubles = 0, bid: Bid | null = null): Hand {
  const dominoes = [
    ...Array.from({ length: doubles }, (_, i) => createDomino(i, i)),
    ...Array.from({ length: 7 - doubles }, (_, i) => createDomino(6, i)),
  ];
  return { playerId, team: Teams.TeamA, dominoes, bid };
}

function game(bid: Bid | null, p1Doubles = 0, others: (Bid | null)[] = [null, null, null]): Game {
  return {
    id: 'g1',
    name: 'Game 1',
    firstActionBy: 'p1',
    bid,
    biddingPlayerId: null,
    trump: null,
    currentPlayerId: 'p1',
    hands: [hand('p1', p1Doubles), ...others.map((b, i) => hand(`p${i + 2}`, 0, b))],
    currentTrick: createTrick(),
    tricks: [],
  };
}

describe('availableBids', () => {
  it('offers Pass and 30 through 84 on an empty table, but no marks', () => {
    const bids = availableBids(game(null), 'p1');
    expect(bids[0]).toBe(Bid.Pass);
    expect(bids).toContain(Bid.Thirty);
    expect(bids.at(-1)).toBe(Bid.EightyFour);
  });

  it('only offers bids strictly above the current bid', () => {
    const bids = availableBids(game(Bid.ThirtyFive), 'p1');
    expect(bids).not.toContain(Bid.ThirtyFive);
    expect(bids).not.toContain(Bid.Thirty);
    expect(bids).toContain(Bid.ThirtySix);
  });

  it('climbs the marks ladder one rung at a time', () => {
    expect(availableBids(game(Bid.FortyTwo), 'p1')).not.toContain(Bid.ThreeMarks);
    expect(availableBids(game(Bid.EightyFour), 'p1')).toEqual([Bid.Pass, Bid.ThreeMarks]);
    expect(availableBids(game(Bid.ThreeMarks), 'p1')).toEqual([Bid.Pass, Bid.FourMarks]);
    expect(availableBids(game(Bid.FourMarks), 'p1')).toEqual([Bid.Pass, Bid.FiveMarks]);
    expect(availableBids(game(Bid.Plunge), 'p1')).toEqual([Bid.Pass, Bid.FiveMarks]);
  });

  it('offers Plunge only with at least four doubles', () => {
    expect(availableBids(game(null, 3), 'p1')).not.toContain(Bid.Plunge);
    expect(availableBids(game(null, 4), 'p1')).toContain(Bid.Plunge);
  });

  it('stops offering Plunge once the bid reaches 4 Marks', () => {
    expect(availableBids(game(Bid.ThreeMarks, 4), 'p1')).toContain(Bid.Plunge);
    expect(availableBids(game(Bid.FourMarks, 4), 'p1')).not.toContain(Bid.Plunge);
  });

  it('forces a bid when the other three passed', () => {
    expect(availableBids(game(null, 0, [Bid.Pass, Bid.Pass, Bid.Pass]), 'p1')).not.toContain(Bid.Pass);
  });
});

describe('availableTrumps', () => {
  it('offers only the named suits under a one-mark bid', () => {
    const trumps = availableTrumps(game(Bid.FortyOne));
    expect(trumps).toHaveLength(7);
    expect(trumps).not.toContain(Suit.None);
    expect(trumps).not.toContain(Suit.Low);
  });

  it('adds Follow Me and every Low doubles rule at 42 and above', () => {
    for (const bid of [Bid.FortyTwo, Bid.EightyFour]) {
      expect(availableTrumps(game(bid))).toEqual(
        expect.arrayContaining([Suit.None, Suit.Low, Suit.LowDoublesLow, Suit.LowDoublesOwnSuit])
      );
    }
  });

  // A Plunge must take every trick, so Low (lose every trick) makes no sense - but Follow Me does.
  it('offers the named suits and Follow Me on a Plunge, but no Low', () => {
    const trumps = availableTrumps(game(Bid.Plunge));
    expect(trumps).toContain(Suit.None);
    expect(trumps).toContain(Suit.Sixes);
    for (const low of [Suit.Low, Suit.LowDoublesLow, Suit.LowDoublesOwnSuit]) {
      expect(trumps).not.toContain(low);
    }
  });

  it('never offers Doubles as a trump', () => {
    expect(availableTrumps(game(Bid.FortyTwo))).not.toContain(Suit.Doubles);
  });
});

describe('assertValidTrump', () => {
  it('rejects Follow Me and Low under 42', () => {
    expect(() => assertValidTrump(game(Bid.Thirty), Suit.None)).toThrow(ValidationError);
    expect(() => assertValidTrump(game(Bid.Thirty), Suit.Low)).toThrow(ValidationError);
    expect(() => assertValidTrump(game(Bid.Thirty), Suit.LowDoublesOwnSuit)).toThrow(ValidationError);
  });

  it('rejects Low on a Plunge, but accepts Follow Me', () => {
    expect(() => assertValidTrump(game(Bid.Plunge), Suit.Low)).toThrow(ValidationError);
    expect(() => assertValidTrump(game(Bid.Plunge), Suit.LowDoublesLow)).toThrow(ValidationError);
    expect(() => assertValidTrump(game(Bid.Plunge), Suit.LowDoublesOwnSuit)).toThrow(ValidationError);
    expect(() => assertValidTrump(game(Bid.Plunge), Suit.None)).not.toThrow();
  });

  it('accepts a named suit at any bid', () => {
    expect(() => assertValidTrump(game(Bid.Thirty), Suit.Sixes)).not.toThrow();
  });
});

describe('assertValidBid', () => {
  it('rejects a marks bid that skips a rung', () => {
    expect(() => assertValidBid(game(Bid.FortyTwo), 'p1', Bid.ThreeMarks)).toThrow(ValidationError);
    expect(() => assertValidBid(game(Bid.EightyFour), 'p1', Bid.FourMarks)).toThrow(ValidationError);
  });

  it('rejects Plunge without four doubles', () => {
    expect(() => assertValidBid(game(null, 3), 'p1', Bid.Plunge)).toThrow(ValidationError);
  });

  it('accepts the next marks rung and a Plunge with four doubles', () => {
    expect(() => assertValidBid(game(Bid.EightyFour), 'p1', Bid.ThreeMarks)).not.toThrow();
    expect(() => assertValidBid(game(null, 4), 'p1', Bid.Plunge)).not.toThrow();
  });
});
