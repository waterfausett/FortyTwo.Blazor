import { createDomino, type Domino } from '@fortytwo/rules';

// Dominoes as ints 0..27 in the ML engine's order (0/0, 0/1, ... 6/6), which the encoder's one-hots use.
export const DOMINOES: Domino[] = [];
for (let lo = 0; lo <= 6; lo++) for (let hi = lo; hi <= 6; hi++) DOMINOES.push(createDomino(lo, hi));

export function toIndex(d: Domino): number {
  const lo = Math.min(d.top, d.bottom);
  const hi = Math.max(d.top, d.bottom);
  return lo * 7 - (lo * (lo - 1)) / 2 + (hi - lo);
}

export const VALUE = DOMINOES.map((d) => ((d.top + d.bottom) % 5 === 0 ? d.top + d.bottom : 0));
export const IS_DOUBLE = DOMINOES.map((d) => d.top === d.bottom);
export const FULL_MASK = 2 ** 28 - 1;
