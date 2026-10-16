import { describe, it, expect } from 'vitest';
import { lowAllowedIfWon, availableBids, availableTrumps, assertValidBid, assertValidTrump } from './validation';
import { Suit, LOW_TRUMPS } from './suit';
import type { HouseRules } from './houseRules';
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

// Bidding order p1, p2, p3, p4. `bids` are the bids already made, in seat order.
function biddingGame(bids: (Bid | null)[], rules?: Partial<HouseRules>, extra: Partial<Game> = {}): Game {
  const ids = ['p1', 'p2', 'p3', 'p4'];
  const hands = ids.map((playerId, i) => ({
    playerId,
    team: i % 2 === 0 ? Teams.TeamA : Teams.TeamB,
    dominoes: [] as ReturnType<typeof createDomino>[],
    bid: bids[i] ?? null,
  }));
  const high = bids.reduce<{ bid: Bid | null; by: string | null }>(
    (best, b, i) => (b !== null && b !== Bid.Pass && (best.bid === null || b > best.bid) ? { bid: b, by: ids[i] } : best),
    { bid: null, by: null }
  );
  return {
    id: 'g1', name: 'Game 1', firstActionBy: 'p1', bid: high.bid, biddingPlayerId: high.by, trump: null,
    currentPlayerId: ids[bids.filter((b) => b !== null).length] ?? high.by,
    hands, currentTrick: createTrick(),
    tricks: [],
    ...(rules ? { rules: { low: 'on', plunge: true, allPass: 'forceLast', marksToWin: 7, ...rules } as HouseRules } : {}),
    ...extra,
  };
}

// The detail of the ValidationError a trump is turned down with (its message is only the title).
function trumpError(game: Game, suit: Suit): string | undefined {
  try {
    assertValidTrump(game, suit);
  } catch (e) {
    return (e as ValidationError).detail;
  }
  return undefined;
}

const FOUR_DOUBLES = [createDomino(0, 0), createDomino(1, 1), createDomino(2, 2), createDomino(3, 3)];

describe('house rules: all pass', () => {
  it('forces the last bidder under the default rules', () => {
    const game = biddingGame([Bid.Pass, Bid.Pass, Bid.Pass, null]);
    expect(availableBids(game, 'p4')).not.toContain(Bid.Pass);
    expect(() => assertValidBid(game, 'p4', Bid.Pass)).toThrow(ValidationError);
  });

  it('lets the last bidder pass under redeal', () => {
    const game = biddingGame([Bid.Pass, Bid.Pass, Bid.Pass, null], { allPass: 'redeal' });
    expect(availableBids(game, 'p4')[0]).toBe(Bid.Pass);
    expect(() => assertValidBid(game, 'p4', Bid.Pass)).not.toThrow();
  });
});

describe('house rules: plunge', () => {
  it('offers Plunge with four doubles by default', () => {
    const game = biddingGame([null, null, null, null]);
    game.hands[0].dominoes = FOUR_DOUBLES;
    expect(availableBids(game, 'p1')).toContain(Bid.Plunge);
  });

  it('never offers Plunge when it is off', () => {
    const game = biddingGame([null, null, null, null], { plunge: false });
    game.hands[0].dominoes = FOUR_DOUBLES;
    expect(availableBids(game, 'p1')).not.toContain(Bid.Plunge);
    expect(() => assertValidBid(game, 'p1', Bid.Plunge)).toThrow(ValidationError);
  });
});

describe('house rules: low', () => {
  it('offers Low at 42+ when on, as today', () => {
    const game = biddingGame([Bid.FortyTwo, Bid.Pass, Bid.Pass, Bid.Pass], { low: 'on' });
    expect(availableTrumps(game)).toEqual(expect.arrayContaining([...LOW_TRUMPS]));
  });

  it('never offers Low when off, with a reason', () => {
    const game = biddingGame([Bid.Pass, Bid.Pass, Bid.Pass, Bid.EightyFour], { low: 'off' });
    expect(availableTrumps(game).some((s) => LOW_TRUMPS.includes(s as (typeof LOW_TRUMPS)[number]))).toBe(false);
    expect(availableTrumps(game)).toContain(Suit.None);
    expect(trumpError(game, Suit.Low)).toMatch(/isn't played at this table/);
  });

  it('offers Low to a forced bidder at 42+ under forcedOnly', () => {
    const game = biddingGame([Bid.Pass, Bid.Pass, Bid.Pass, Bid.FortyTwo], { low: 'forcedOnly' }, { forcedBid: true });
    expect(availableTrumps(game)).toEqual(expect.arrayContaining([...LOW_TRUMPS]));
  });

  it('still needs 42 from a forced bidder under forcedOnly', () => {
    const game = biddingGame([Bid.Pass, Bid.Pass, Bid.Pass, Bid.Thirty], { low: 'forcedOnly' }, { forcedBid: true });
    expect(availableTrumps(game)).not.toContain(Suit.Low);
    expect(trumpError(game, Suit.Low)).toMatch(/needs a bid of at least 42/);
  });

  it('refuses Low to a bidder who outbid someone under forcedOnly', () => {
    const game = biddingGame([Bid.Thirty, Bid.Pass, Bid.Pass, Bid.FortyTwo], { low: 'forcedOnly' });
    expect(availableTrumps(game)).not.toContain(Suit.Low);
    expect(trumpError(game, Suit.Low)).toMatch(/only for a player forced to bid/);
  });

  it('refuses Low to an opener whose bid stood under forcedOnly', () => {
    // The other three all passed here too, but after the opener bid: not forced, so no flag.
    const game = biddingGame([Bid.FortyTwo, Bid.Pass, Bid.Pass, Bid.Pass], { low: 'forcedOnly' });
    expect(availableTrumps(game)).not.toContain(Suit.Low);
    expect(trumpError(game, Suit.Low)).toMatch(/only for a player forced to bid/);
  });
});

describe('lowAllowedIfWon', () => {
  it('follows the low rule, and under forcedOnly whether the other three passed', () => {
    expect(lowAllowedIfWon(biddingGame([null, null, null, null]), 'p1')).toBe(true);
    expect(lowAllowedIfWon(biddingGame([null, null, null, null], { low: 'off' }), 'p1')).toBe(false);
    expect(lowAllowedIfWon(biddingGame([null, null, null, null], { low: 'forcedOnly' }), 'p1')).toBe(false);
    expect(lowAllowedIfWon(biddingGame([Bid.Pass, Bid.Pass, Bid.Pass, null], { low: 'forcedOnly' }), 'p4')).toBe(true);
    expect(lowAllowedIfWon(biddingGame([Bid.Pass, Bid.Thirty, Bid.Pass, null], { low: 'forcedOnly' }), 'p4')).toBe(false);
  });
});
