import { describe, it, expect } from 'vitest';
import { createTrick, trickValue, isTrickFull, isTrickEmpty, addDominoToTrick } from './trick';
import { createDomino } from './domino';
import { Suit } from './suit';

describe('trick', () => {
  it('starts empty with 4 null dominoes', () => {
    const t = createTrick();
    expect(isTrickEmpty(t)).toBe(true);
    expect(t.dominoes).toEqual([null, null, null, null]);
    expect(t.playerId).toBeNull();
    expect(t.team).toBeNull();
    expect(t.suit).toBeNull();
  });

  it('an empty trick has value 1 (base point), not 0', () => {
    // C# `Dominos?.Sum(x => x?.Value) + 1 ?? 0`: for an all-null Dominos array,
    // Sum(...) returns 0 (never null), so Value = 0 + 1 = 1. The `?? 0` never fires.
    expect(trickValue(createTrick())).toBe(1);
  });

  it('trick value is the sum of domino values plus 1', () => {
    let t = createTrick();
    t = addDominoToTrick(t, createDomino(5, 0), Suit.Sixes); // value 5
    expect(trickValue(t)).toBe(6);
  });

  it('adding a domino sets suit from the first domino played only', () => {
    let t = createTrick();
    t = addDominoToTrick(t, createDomino(3, 6), Suit.Sixes); // suit of this domino w/ trump Sixes -> Sixes
    expect(t.suit).toBe(Suit.Sixes);

    t = addDominoToTrick(t, createDomino(2, 4), Suit.Sixes); // second domino shouldn't change suit
    expect(t.suit).toBe(Suit.Sixes);
  });

  it('isTrickFull needs exactly 3 non-null slots when trump is Low, 4 otherwise', () => {
    let t = createTrick();
    t = addDominoToTrick(t, createDomino(1, 1), Suit.Low);
    t = addDominoToTrick(t, createDomino(2, 2), Suit.Low);
    expect(isTrickFull(t, Suit.Low)).toBe(false);
    t = addDominoToTrick(t, createDomino(3, 3), Suit.Low);
    expect(isTrickFull(t, Suit.Low)).toBe(true);
    expect(isTrickFull(t, Suit.Sixes)).toBe(false);

    t = addDominoToTrick(t, createDomino(4, 4), Suit.Sixes);
    expect(isTrickFull(t, Suit.Sixes)).toBe(true);
  });

  it('throws when adding to a full trick', () => {
    let t = createTrick();
    t = addDominoToTrick(t, createDomino(1, 1), Suit.Sixes);
    t = addDominoToTrick(t, createDomino(2, 2), Suit.Sixes);
    t = addDominoToTrick(t, createDomino(3, 3), Suit.Sixes);
    t = addDominoToTrick(t, createDomino(4, 4), Suit.Sixes);
    expect(() => addDominoToTrick(t, createDomino(5, 5), Suit.Sixes)).toThrow();
  });

  it('addDominoToTrick returns a new Trick object rather than mutating in place', () => {
    const t1 = createTrick();
    const t2 = addDominoToTrick(t1, createDomino(1, 1), Suit.Sixes);
    expect(t1).not.toBe(t2);
    expect(t1.dominoes).toEqual([null, null, null, null]);
    expect(t2.dominoes[0]).toEqual(createDomino(1, 1));
  });
});
