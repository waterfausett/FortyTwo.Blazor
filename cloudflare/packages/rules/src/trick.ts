import { Domino, dominoValue, getSuit } from './domino';
import { Suit, isLow } from './suit';
import { Teams } from './teams';

export interface Trick {
  playerId: string | null;
  team: Teams | null;
  suit: Suit | null;
  dominoes: (Domino | null)[];
}

export function createTrick(): Trick {
  return { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] };
}

// Points for taking the trick: its count dominoes plus 1 for the trick itself - so even an empty
// trick is worth 1.
export function trickValue(t: Trick): number {
  return t.dominoes.reduce((sum, d) => sum + (d ? dominoValue(d) : 0), 0) + 1;
}

export function isTrickFull(t: Trick, trump: Suit): boolean {
  return isLow(trump)
    ? t.dominoes.filter((x) => x !== null).length === 3
    : t.dominoes.every((x) => x !== null);
}

export function isTrickEmpty(t: Trick): boolean {
  return t.dominoes.every((x) => x === null);
}

// Returns a new Trick with `domino` in the next open slot; the first domino sets the led suit.
export function addDominoToTrick(t: Trick, domino: Domino, trump: Suit): Trick {
  const index = t.dominoes.indexOf(null);

  if (index === -1) throw new Error('Trick is already full');

  const dominoes = [...t.dominoes];
  dominoes[index] = domino;

  const suit = index === 0 ? (t.suit ?? getSuit(domino, trump)) : t.suit;

  return { ...t, suit, dominoes };
}
