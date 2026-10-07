// Experimental: how a finished trick leaves the table. Pick one with `?sweep=<mode>` on the match
// URL; the choice sticks (localStorage) until changed.
//
//   side   - the original: slide straight off left (us) or right (them).
//   seat   - fly to the winning player's seat plate.
//   pile   - fly to the exact spot on the winning team's pile where the trick lands.
//   gather - collapse onto the winning domino, then fly that stack to the pile.
import type { Seat } from '@fortytwo/client';

export const SWEEP_MODES = ['side', 'seat', 'pile', 'gather'] as const;
export type SweepMode = (typeof SWEEP_MODES)[number];

const DEFAULT_SWEEP_MODE: SweepMode = 'pile';
const STORAGE_KEY = 'fortytwo.sweepMode';

function isSweepMode(value: unknown): value is SweepMode {
  return SWEEP_MODES.includes(value as SweepMode);
}

export function readSweepMode(search: string = window.location.search): SweepMode {
  const fromUrl = new URLSearchParams(search).get('sweep');
  try {
    if (isSweepMode(fromUrl)) {
      localStorage.setItem(STORAGE_KEY, fromUrl);
      return fromUrl;
    }
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isSweepMode(stored)) return stored;
  } catch {
    // Storage blocked - the URL still works for this visit.
    if (isSweepMode(fromUrl)) return fromUrl;
  }
  return DEFAULT_SWEEP_MODE;
}

// Gather is two moves (in, then off), so it gets a longer share of the hold.
export function sweepDurationMs(mode: SweepMode): number {
  return mode === 'gather' ? 750 : 450;
}

export interface Point {
  x: number;
  y: number;
}

export function centerOf(rect: DOMRect): Point {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

// Where the trick will land in a team's side pile: the top of our newest-first pile, or just past
// the last row of theirs (clamped to the pile's box in case it has scrolled).
export function pileLandingPoint(root: ParentNode, side: 'us' | 'them'): Point | null {
  const history = root.querySelector(side === 'us' ? '.player-team-tricks .trick-history' : '.opponent-tricks .trick-history');
  if (!history) return null;
  const box = history.getBoundingClientRect();
  const x = box.left + box.width / 2;
  if (side === 'us') return { x, y: box.top };
  const last = history.lastElementChild?.getBoundingClientRect();
  return { x, y: last ? Math.min(last.bottom, box.bottom) : box.top };
}

export function seatPoint(root: ParentNode, seat: Seat): Point | null {
  const plate = root.querySelector(`.seat-${seat} .seat-plate`);
  return plate ? centerOf(plate.getBoundingClientRect()) : null;
}
