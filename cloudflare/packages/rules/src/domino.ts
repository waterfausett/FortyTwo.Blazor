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
  if (trump == null || suit === trump) {
    return d.top === suit || d.bottom === suit;
  }
  return (d.top === suit && d.bottom !== trump) || (d.bottom === suit && d.top !== trump);
}

export function getSuit(d: Domino, trump: Suit): Suit {
  return isOfSuit(d, trump) ? trump : (Math.max(d.top, d.bottom) as Suit);
}

export function getSuitValue(d: Domino, suit: Suit, trump: Suit): number {
  if (isOfSuit(d, suit, trump)) {
    return isDouble(d) ? 7 : d.top === suit ? d.bottom : d.top;
  }
  if (isOfSuit(d, trump)) {
    return 10 + (isDouble(d) ? 7 : d.top === suit ? d.bottom : d.top);
  }
  return -1;
}

export function dominoEquals(a: Domino, b: Domino): boolean {
  return (a.top === b.top && a.bottom === b.bottom) || (a.top === b.bottom && a.bottom === b.top);
}
