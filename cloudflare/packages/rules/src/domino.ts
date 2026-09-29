import { Suit } from './suit';

export interface Domino {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
}

export function createDomino(top: number, bottom: number): Domino {
  if (top < 0 || bottom < 0) throw new RangeError('Domino halves must be non-negative');
  const [lo, hi] = top <= bottom ? [top, bottom] : [bottom, top];
  return { id: `${lo}/${hi}`, top: lo, bottom: hi };
}

export function dominoValue(d: Domino): number {
  const sum = d.top + d.bottom;
  return sum % 5 === 0 ? sum : 0;
}

export function isDouble(d: Domino): boolean {
  return d.top === d.bottom;
}

export function isOfSuit(d: Domino, suit: Suit, trump?: Suit | null): boolean {
  // Doubles are a suit of their own: a double belongs only to Doubles, never to its number.
  if (trump === Suit.LowDoublesOwnSuit) {
    return suit === Suit.Doubles ? isDouble(d) : !isDouble(d) && (d.top === suit || d.bottom === suit);
  }
  if (trump == null || suit === trump) {
    return d.top === suit || d.bottom === suit;
  }
  return (d.top === suit && d.bottom !== trump) || (d.bottom === suit && d.top !== trump);
}

export function getSuit(d: Domino, trump: Suit): Suit {
  if (trump === Suit.LowDoublesOwnSuit && isDouble(d)) return Suit.Doubles;
  return isOfSuit(d, trump) ? trump : (Math.max(d.top, d.bottom) as Suit);
}

// Rank of `d` in a trick led in `suit` - higher wins. -1 means it can't win (off suit, no trump).
export function getSuitValue(d: Domino, suit: Suit, trump: Suit): number {
  if (isOfSuit(d, suit, trump)) {
    // Within the Doubles suit, double-six is highest and double-blank lowest.
    if (suit === Suit.Doubles) return d.top;
    // A double normally tops its suit (7, above the 0-6 of its other half); when doubles are low
    // it drops beneath the whole suit (-0.5, still above off-suit's -1).
    if (isDouble(d)) return trump === Suit.LowDoublesLow ? -0.5 : 7;
    return d.top === suit ? d.bottom : d.top;
  }
  if (isOfSuit(d, trump)) {
    return 10 + (isDouble(d) ? 7 : d.top === trump ? d.bottom : d.top);
  }
  return -1;
}

export function dominoEquals(a: Domino, b: Domino): boolean {
  return (a.top === b.top && a.bottom === b.bottom) || (a.top === b.bottom && a.bottom === b.top);
}
