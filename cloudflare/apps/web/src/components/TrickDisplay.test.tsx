// TrickDisplay.tsx renders the current trick's slots (4 normally, 3 for Suit.Low - matching
// trick.ts's isTrickFull, which treats a Low-trump trick as full at 3 dominoes) around a table
// center, rendering exactly one Domino per non-null slot. Reuses chip.css's existing
// .custom-chip/.badge classes for the trick's running point value, matching Match.razor's
// `<Chip Context="ContextualClass.Info"><Label>Points</Label><Badge>...</Badge></Chip>` usage
// next to trick piles - no new CSS.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDomino, Suit, type Trick } from '@fortytwo/rules';
import { TrickDisplay } from './TrickDisplay';

afterEach(() => {
  cleanup();
});

function trickWith(dominoes: (ReturnType<typeof createDomino> | null)[]): Trick {
  return { playerId: null, team: null, suit: null, dominoes };
}

describe('TrickDisplay', () => {
  it('renders one Domino per non-null trick slot', () => {
    const trick = trickWith([createDomino(1, 2), null, createDomino(3, 4), null]);
    render(<TrickDisplay trick={trick} trump={Suit.Sixes} />);

    expect(screen.getAllByTestId('domino')).toHaveLength(2);
  });

  it('renders zero dominoes for an empty trick', () => {
    const trick = trickWith([null, null, null, null]);
    render(<TrickDisplay trick={trick} trump={Suit.Sixes} />);

    expect(screen.queryAllByTestId('domino')).toHaveLength(0);
  });

  it('renders a full 4-slot trick with all 4 dominoes', () => {
    const trick = trickWith([createDomino(0, 0), createDomino(1, 1), createDomino(2, 2), createDomino(3, 3)]);
    render(<TrickDisplay trick={trick} trump={Suit.Sixes} />);

    expect(screen.getAllByTestId('domino')).toHaveLength(4);
  });

  it('only considers the first 3 slots when trump is Low', () => {
    // A 4th populated slot shouldn't happen for a real Low trick (trick.ts's isTrickFull caps it
    // at 3), but the component should still only ever render up to 3 for Low regardless.
    const trick = trickWith([createDomino(0, 0), createDomino(1, 1), createDomino(2, 2), createDomino(3, 3)]);
    render(<TrickDisplay trick={trick} trump={Suit.Low} />);

    expect(screen.getAllByTestId('domino')).toHaveLength(3);
  });
});
