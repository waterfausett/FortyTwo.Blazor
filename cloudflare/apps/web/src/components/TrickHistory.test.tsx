// TrickHistory.tsx renders one team's completed-trick pile plus their Points badge - see its own
// header comment for the Match.razor behavior it ports (most-recent-first for "mine", badge below
// the pile; completion order for "opponent", badge above the pile).
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

  it('shows the Points badge with the given value', () => {
    render(<TrickHistory tricks={[]} points={12} align="mine" />);

    expect(screen.getByText('12')).not.toBeNull();
  });

  it('renders most-recent-trick first for "mine", with the badge after the pile', () => {
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
    expect(root!.querySelector('.trick-history')?.nextElementSibling?.className).toContain('custom-chip');
  });

  it('renders tricks in completion order for "opponent", with the badge before the pile', () => {
    const tricks = [trickWith([createDomino(0, 0)]), trickWith([createDomino(6, 6)])];
    const { container } = render(<TrickHistory tricks={tricks} points={0} align="opponent" />);

    const root = container.querySelector('.opponent-tricks');
    expect(root).not.toBeNull();
    // Badge is the FIRST child, the trick-history pile comes after it.
    expect(root!.firstElementChild?.className).toContain('custom-chip');
    expect(root!.querySelector('.trick-history')).not.toBeNull();
  });
});
