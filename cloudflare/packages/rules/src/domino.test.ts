import { describe, it, expect } from 'vitest';
import { createDomino, dominoValue, isDouble, getSuit, isOfSuit, getSuitValue, dominoEquals } from './domino';
import { Suit } from './suit';

describe('domino', () => {
  it('values dominoes that sum to a multiple of 5, zero otherwise', () => {
    expect(dominoValue(createDomino(5, 0))).toBe(5);
    expect(dominoValue(createDomino(4, 1))).toBe(5);
    expect(dominoValue(createDomino(3, 3))).toBe(0);
    expect(dominoValue(createDomino(5, 5))).toBe(10);
  });

  it('identifies doubles', () => {
    expect(isDouble(createDomino(3, 3))).toBe(true);
    expect(isDouble(createDomino(3, 4))).toBe(false);
  });

  it('a domino belongs to trump suit if either half matches trump', () => {
    expect(isOfSuit(createDomino(6, 2), Suit.Sixes)).toBe(true);
    expect(isOfSuit(createDomino(2, 3), Suit.Sixes)).toBe(false);
  });

  it('a domino with one half matching trump belongs to trump, not its other suit', () => {
    // 3-6 with trump=Sixes: belongs to Sixes, NOT to Threes
    expect(isOfSuit(createDomino(3, 6), Suit.Threes, Suit.Sixes)).toBe(false);
    expect(isOfSuit(createDomino(3, 6), Suit.Sixes, Suit.Sixes)).toBe(true);
  });

  it('getSuit returns trump for a trump domino, else the higher pip value', () => {
    expect(getSuit(createDomino(3, 6), Suit.Sixes)).toBe(Suit.Sixes);
    expect(getSuit(createDomino(2, 4), Suit.Sixes)).toBe(Suit.Fours);
  });

  it('getSuitValue ranks trump dominoes above the led suit, doubles as 7', () => {
    // led suit = Fours, trump = Sixes
    expect(getSuitValue(createDomino(4, 4), Suit.Fours, Suit.Sixes)).toBe(7); // double of led suit
    expect(getSuitValue(createDomino(2, 4), Suit.Fours, Suit.Sixes)).toBe(2); // off value in led suit
    expect(getSuitValue(createDomino(1, 6), Suit.Fours, Suit.Sixes)).toBe(11); // trump beats led suit: 10 + 1
    expect(getSuitValue(createDomino(6, 6), Suit.Fours, Suit.Sixes)).toBe(17); // trump double: 10 + 7
    expect(getSuitValue(createDomino(0, 1), Suit.Fours, Suit.Sixes)).toBe(-1); // neither suit
  });

  describe('Low doubles rules', () => {
    const d66 = createDomino(6, 6);
    const d60 = createDomino(6, 0);
    const d61 = createDomino(6, 1);
    const d55 = createDomino(5, 5);

    it('doubles are high: the double tops its suit', () => {
      expect(getSuit(d66, Suit.Low)).toBe(Suit.Sixes);
      expect(getSuitValue(d66, Suit.Sixes, Suit.Low)).toBeGreaterThan(getSuitValue(d61, Suit.Sixes, Suit.Low));
    });

    it('doubles are low: the double sits under six-blank but still beats off-suit', () => {
      expect(getSuit(d66, Suit.LowDoublesLow)).toBe(Suit.Sixes);
      expect(isOfSuit(d66, Suit.Sixes, Suit.LowDoublesLow)).toBe(true);
      expect(getSuitValue(d66, Suit.Sixes, Suit.LowDoublesLow)).toBeLessThan(getSuitValue(d60, Suit.Sixes, Suit.LowDoublesLow));
      expect(getSuitValue(d66, Suit.Sixes, Suit.LowDoublesLow)).toBeGreaterThan(
        getSuitValue(d55, Suit.Sixes, Suit.LowDoublesLow)
      );
    });

    it('doubles are their own suit: a double is only a Double, ranked by its pips', () => {
      expect(getSuit(d66, Suit.LowDoublesOwnSuit)).toBe(Suit.Doubles);
      expect(getSuit(d61, Suit.LowDoublesOwnSuit)).toBe(Suit.Sixes);
      expect(isOfSuit(d66, Suit.Sixes, Suit.LowDoublesOwnSuit)).toBe(false);
      expect(isOfSuit(d61, Suit.Doubles, Suit.LowDoublesOwnSuit)).toBe(false);
      // A double can't win a Sixes trick, and double-six is the highest Double.
      expect(getSuitValue(d66, Suit.Sixes, Suit.LowDoublesOwnSuit)).toBe(-1);
      expect(getSuitValue(d66, Suit.Doubles, Suit.LowDoublesOwnSuit)).toBeGreaterThan(
        getSuitValue(d55, Suit.Doubles, Suit.LowDoublesOwnSuit)
      );
      expect(getSuitValue(d61, Suit.Doubles, Suit.LowDoublesOwnSuit)).toBe(-1);
    });
  });

  it('dominoes are equal regardless of orientation', () => {
    expect(dominoEquals(createDomino(2, 5), createDomino(5, 2))).toBe(true);
    expect(dominoEquals(createDomino(2, 5), createDomino(2, 6))).toBe(false);
  });
});
