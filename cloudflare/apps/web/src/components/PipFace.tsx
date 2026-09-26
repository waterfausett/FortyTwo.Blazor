// A single domino half (a 3x3 pip grid) standing in for a suit - used to show trump at a glance
// on the trump picker, the scoreboard and the bidder's seat. "Follow Me" (Suit.None) and Low have
// no pip count, so they render as a short word on the same tile instead.
import type { JSX } from 'react';
import { Suit, suitToPrettyString } from '@fortytwo/rules';

// Which of the 9 grid cells (row-major, 0-8) carry a pip for each count - a standard die face,
// matching Domino.tsx's layout (corners from 2 up, middle row pair for 6, center for odd counts).
const PIP_CELLS: Record<number, number[]> = {
  0: [],
  1: [4],
  2: [2, 6],
  3: [2, 4, 6],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

export function PipFace({ suit, size = 'md' }: { suit: Suit; size?: 'xs' | 'md' }): JSX.Element {
  const label = suitToPrettyString(suit);

  if (suit === Suit.None || suit === Suit.Low) {
    return (
      <span className={`pip-face pip-face-${size} pip-face-word`} title={label} aria-hidden="true">
        {suit === Suit.None ? 'FM' : 'Lo'}
      </span>
    );
  }

  const cells = PIP_CELLS[suit];
  return (
    <span className={`pip-face pip-face-${size}`} data-value={suit} title={label} aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={cells.includes(i) ? 'pip' : 'pip-empty'} />
      ))}
    </span>
  );
}
