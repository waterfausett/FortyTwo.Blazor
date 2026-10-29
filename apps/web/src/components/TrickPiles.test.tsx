// TrickPiles.tsx renders both teams' piles below the hand on small screens: each headed by its
// points, its tricks newest first with what each was worth.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDomino, Teams, type Trick } from '@fortytwo/rules';
import { TrickPiles } from './TrickPiles';

afterEach(() => {
  cleanup();
});

function trickWith(dominoes: ReturnType<typeof createDomino>[]): Trick {
  return { playerId: 'p1', team: Teams.TeamA, suit: null, dominoes };
}

const empty = { tricks: [], points: 0, target: null };

describe('TrickPiles', () => {
  it('heads each pile with its points, out of the target for the bidding team', () => {
    const { container } = render(
      <TrickPiles us={{ tricks: [], points: 12, target: 34 }} them={{ tricks: [], points: 5, target: null }} stacked={false} />
    );

    const points = [...container.querySelectorAll('.trick-pile-points')].map((el) => el.textContent);
    expect(points).toEqual(['12 of 34', '5 pts']);
  });

  it('lists tricks newest first, each with the points it was worth', () => {
    const older = trickWith([createDomino(0, 0), createDomino(1, 0), createDomino(2, 0), createDomino(3, 0)]);
    const newer = trickWith([createDomino(5, 5), createDomino(6, 0), createDomino(6, 1), createDomino(6, 2)]);
    const { container } = render(
      <TrickPiles us={{ tricks: [older, newer], points: 11, target: null }} them={empty} stacked={false} />
    );

    const values = [...container.querySelectorAll('.trick-pile-us .trick-pile-value')].map((el) => el.textContent);
    expect(values).toEqual(['+11', '+1']);
  });

  it('says when a pile has no tricks yet', () => {
    render(<TrickPiles us={empty} them={empty} stacked={false} />);

    expect(screen.getAllByText('No tricks yet')).toHaveLength(2);
  });

  it('notes when only the last two tricks are shown', () => {
    const { rerender } = render(<TrickPiles us={empty} them={empty} stacked={false} />);
    expect(screen.queryByText(/Tricks are stacked/)).toBeNull();

    rerender(<TrickPiles us={empty} them={empty} stacked />);
    expect(screen.getByText(/Tricks are stacked/)).not.toBeNull();
  });
});
