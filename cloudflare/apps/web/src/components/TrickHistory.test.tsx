// TrickHistory.tsx renders one team's completed-trick pile headed by its point total - see its own
// header comment for the Match.razor behavior it ports (most-recent-first for "mine", completion
// order for "opponent").
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDomino, Teams, type Trick } from '@fortytwo/rules';
import { TrickHistory } from './TrickHistory';

afterEach(() => {
  cleanup();
});

function trickWith(dominoes: ReturnType<typeof createDomino>[]): Trick {
  return { playerId: 'p1', team: Teams.TeamA, suit: null, dominoes };
}

describe('TrickHistory', () => {
  it('renders one Domino per domino across all tricks', () => {
    const tricks = [trickWith([createDomino(1, 1), createDomino(2, 2)]), trickWith([createDomino(3, 3)])];
    render(<TrickHistory tricks={tricks} points={5} align="mine" />);

    expect(screen.getAllByTestId('domino')).toHaveLength(3);
  });

  it('shows the point total with the given value', () => {
    render(<TrickHistory tricks={[]} points={12} align="mine" />);

    expect(screen.getByText('12')).not.toBeNull();
  });

  it("shows how many points the bidding team needs when given a target", () => {
    const { container } = render(<TrickHistory tricks={[]} points={12} align="mine" target={34} />);

    expect(container.querySelector('.pile-points')?.textContent).toBe('12 of 34');
  });

  it('renders most-recent-trick first for "mine", headed by the point total', () => {
    // Distinguishable by domino COUNT (Domino tiles render no text), not value.
    const older = trickWith([createDomino(0, 0)]);
    const newer = trickWith([createDomino(6, 6), createDomino(5, 5)]);
    const { container } = render(<TrickHistory tricks={[older, newer]} points={0} align="mine" />);

    const root = container.querySelector('.player-team-tricks');
    expect(root).not.toBeNull();
    const rows = root!.querySelectorAll('.trick-history-row');
    expect(rows).toHaveLength(2);
    // Reversed: the newer (2-domino) trick renders first.
    expect(rows[0].querySelectorAll('[data-testid="domino"]')).toHaveLength(2);
    expect(rows[1].querySelectorAll('[data-testid="domino"]')).toHaveLength(1);
    expect(root!.firstElementChild?.className).toContain('pile-total');
  });

  it('renders tricks in completion order for "opponent", headed by the point total', () => {
    const tricks = [trickWith([createDomino(0, 0)]), trickWith([createDomino(6, 6)])];
    const { container } = render(<TrickHistory tricks={tricks} points={0} align="opponent" />);

    const root = container.querySelector('.opponent-tricks');
    expect(root).not.toBeNull();
    // Point total is the FIRST child, the trick-history pile comes after it.
    expect(root!.firstElementChild?.className).toContain('pile-total');
    expect(root!.querySelector('.trick-history')).not.toBeNull();
  });

  // Regression test: rows used to be keyed by list position, so a new trick arriving at the top
  // of the (newest-first) "mine" pile shifted every row's key - remounting the whole pile and
  // replaying each row's arrival animation. Only the new trick's row should be new.
  it.each(['mine', 'opponent'] as const)('keeps existing rows mounted when a trick is added to the "%s" pile', (align) => {
    const first = trickWith([createDomino(0, 0), createDomino(0, 1)]);
    const second = trickWith([createDomino(1, 1), createDomino(1, 2)]);
    const { container, rerender } = render(<TrickHistory tricks={[first]} points={0} align={align} />);
    const rowBefore = container.querySelector('.trick-history-row')!;

    rerender(<TrickHistory tricks={[first, second]} points={0} align={align} />);

    expect(container.querySelectorAll('.trick-history-row')).toHaveLength(2);
    expect(rowBefore.isConnected).toBe(true);
  });
});
