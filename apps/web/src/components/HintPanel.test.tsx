import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDomino } from '@fortytwo/rules';
import type { Hint } from '@fortytwo/api-types';
import { HintButton, HintDetails } from './HintPanel';
import type { HintController } from '../match/useHint';

afterEach(cleanup);

const controller = (over: Partial<HintController>): HintController => ({
  available: true, state: { status: 'idle' }, ask: vi.fn(), hint: null, ...over,
});

const bidHint: Hint = {
  kind: 'bid',
  suggestion: { bid: 31, trump: 6, pMake: 0.7 },
  options: [{ bid: 30, trump: 6, pMake: 0.8 }, { bid: 31, trump: 6, pMake: 0.7 }],
};
const playHint: Hint = {
  kind: 'play',
  dominoes: [
    { domino: createDomino(4, 6), marks: 0.6, gap: 0, rating: 'best' },
    { domino: createDomino(1, 3), marks: 0.2, gap: 0.4, rating: 'weaker' },
  ],
};
const ready = (hint: Hint) => controller({ state: { status: 'ready', hint }, hint });

describe('HintButton', () => {
  it('shows nothing when no hint can be asked for', () => {
    const { container } = render(<HintButton hint={controller({ available: false })} />);
    expect(container.innerHTML).toBe('');
  });

  it('asks when Hint is pressed, and says it is thinking', () => {
    const ask = vi.fn();
    const { rerender } = render(<HintButton hint={controller({ ask })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hint' }));
    expect(ask).toHaveBeenCalled();
    rerender(<HintButton hint={controller({ state: { status: 'loading' } })} />);
    expect(screen.getByText('Thinking…')).not.toBeNull();
  });

  it('names a bid suggestion without its chances', () => {
    render(<HintButton hint={ready(bidHint)} />);
    expect(screen.getByText('Bid 31 · Sixes')).not.toBeNull();
  });

  it('leaves a play hint to the ringed domino', () => {
    const { container } = render(<HintButton hint={ready(playHint)} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows why it failed, with a way to try again', () => {
    const ask = vi.fn();
    render(<HintButton hint={controller({ state: { status: 'error', message: "Hints aren't available right now." }, ask })} />);
    expect(screen.getByText("Hints aren't available right now.")).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(ask).toHaveBeenCalled();
  });
});

describe('HintDetails', () => {
  it('shows nothing while hint details are off', () => {
    const { container } = render(<HintDetails hint={ready(bidHint)} show={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows a bid hint with its chances and alternatives', () => {
    render(<HintDetails hint={ready(bidHint)} show />);
    expect(screen.getByText('Bid 31 · Sixes, 70% to make')).not.toBeNull();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['30 · Sixes80%', '31 · Sixes70%']);
    expect(rows[1].classList.contains('hint-row-suggested')).toBe(true);
  });

  it('shows a play hint, best first, with the suggested row marked', () => {
    render(<HintDetails hint={ready(playHint)} show />);
    expect(screen.getByText('Play 6-4')).not.toBeNull();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual(['6-4best', '3-1weaker (−0.40 marks)']);
    expect(rows[0].classList.contains('hint-row-suggested')).toBe(true);
  });
});
