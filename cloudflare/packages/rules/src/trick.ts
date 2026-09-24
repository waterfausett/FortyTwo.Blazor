import { Domino, dominoValue, getSuit } from './domino';
import { Suit } from './suit';
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

// Port of C# `Trick.Value`: `Dominos?.Sum(x => x?.Value) + 1 ?? 0`.
// LINQ's nullable Sum never returns null for an all-null/empty sequence — it returns 0 — so
// the `+ 1` always applies and the `?? 0` fallback never actually fires. An empty trick's
// value is therefore 1 (the trick's base point), not 0.
export function trickValue(t: Trick): number {
  return t.dominoes.reduce((sum, d) => sum + (d ? dominoValue(d) : 0), 0) + 1;
}

export function isTrickFull(t: Trick, trump: Suit): boolean {
  return trump === Suit.Low
    ? t.dominoes.filter((x) => x !== null).length === 3
    : t.dominoes.every((x) => x !== null);
}

export function isTrickEmpty(t: Trick): boolean {
  return t.dominoes.every((x) => x === null);
}

// Deliberate deviation from the C# original's in-place `AddDomino`: returns a new Trick
// rather than mutating, since TS/React state should be treated as immutable.
export function addDominoToTrick(t: Trick, domino: Domino, trump: Suit): Trick {
  const index = t.dominoes.indexOf(null);

  if (index === -1) throw new Error('Trick is already full');

  const dominoes = [...t.dominoes];
  dominoes[index] = domino;

  const suit = index === 0 ? (t.suit ?? getSuit(domino, trump)) : t.suit;

  return { ...t, suit, dominoes };
}
