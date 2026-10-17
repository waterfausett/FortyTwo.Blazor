import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDomino } from '@fortytwo/rules';
import type { Hint } from '@fortytwo/api-types';
import { HintPanel } from './HintPanel';
import type { HintController } from '../match/useHint';

afterEach(cleanup);

const controller = (over: Partial<HintController>): HintController => ({
  available: true, state: { status: 'idle' }, ask: vi.fn(), hint: null, ...over,
});

describe('HintPanel', () => {
  it('shows nothing when no hint can be asked for', () => {
    const { container } = render(<HintPanel hint={controller({ available: false })} />);
    expect(container.innerHTML).toBe('');
  });

  it('asks when Hint is pressed, and says it is thinking', () => {
    const ask = vi.fn();
    const { rerender } = render(<HintPanel hint={controller({ ask })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hint' }));
    expect(ask).toHaveBeenCalled();
    rerender(<HintPanel hint={controller({ state: { status: 'loading' } })} />);
    expect(screen.getByText('Thinking…')).not.toBeNull();
  });

  it('shows a play hint, best first, with the suggested row marked', () => {
    const hint: Hint = {
      kind: 'play',
      dominoes: [
        { domino: createDomino(4, 6), marks: 0.6, gap: 0, rating: 'best' },
        { domino: createDomino(1, 3), marks: 0.2, gap: 0.4, rating: 'weaker' },
      ],
    };
    render(<HintPanel hint={controller({ state: { status: 'ready', hint }, hint })} />);
    expect(screen.getByText('Play 6-4')).not.toBeNull();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['6-4best', '3-1weaker (−0.40 marks)']);
    expect(rows[0].classList.contains('hint-row-suggested')).toBe(true);
  });

  it('shows why it failed, with a way to try again', () => {
    const ask = vi.fn();
    render(<HintPanel hint={controller({ state: { status: 'error', message: "Hints aren't available right now." }, ask })} />);
    expect(screen.getByText("Hints aren't available right now.")).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(ask).toHaveBeenCalled();
  });
});
