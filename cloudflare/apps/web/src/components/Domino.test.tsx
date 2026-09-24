// Domino.tsx renders one domino tile: a fixed top/bottom pip-count pair (0-6 pips each,
// standard die-face layout) using domino.css's existing class names (Task 20 brief step 1 - no
// new CSS). Per the Task 20 report's data-model note: the old Domino.razor could flip which half
// ("Top"/"Bottom") displayed via an `Orientation` field on the C# Domino - our TS `Domino` type
// (packages/rules/src/domino.ts) carries no such field (only canonical top<=bottom values), and
// the brief never asks for orientation-flipping, so this component intentionally uses a fixed,
// direct top->top-half / bottom->bottom-half mapping instead of inventing local orientation state.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Domino } from './Domino';

// vitest.config.ts now sets `test.globals: true` (added in this task) so @testing-library/react's
// auto-cleanup self-registers - this explicit afterEach is kept anyway, matching Lobby.test.tsx's
// established belt-and-suspenders pattern, and is harmless to call twice.
afterEach(() => {
  cleanup();
});

describe('Domino', () => {
  it.each([
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 0],
    [6, 0],
  ])('renders %i pips on a half with value %i vs 0', (value) => {
    // Rendered as top=value, bottom=0 (0 pips) so the total pip count on screen equals exactly
    // the pip count contributed by `value`'s half - isolates each half's pip rendering.
    const { container } = render(<Domino top={value} bottom={0} />);
    const topHalf = container.querySelector('[data-value]');
    expect(topHalf).not.toBeNull();

    const expectedPipCounts: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };
    expect(topHalf?.querySelectorAll('span').length).toBe(expectedPipCounts[value]);
  });

  it('renders both halves independently for top and bottom props', () => {
    const { container } = render(<Domino top={6} bottom={1} />);
    const halves = container.querySelectorAll('[data-value]');
    expect(halves).toHaveLength(2);
    expect(halves[0].getAttribute('data-value')).toBe('6');
    expect(halves[0].querySelectorAll('span').length).toBe(6);
    expect(halves[1].getAttribute('data-value')).toBe('1');
    expect(halves[1].querySelectorAll('span').length).toBe(1);
  });

  it('renders the divider line between halves', () => {
    const { container } = render(<Domino top={2} bottom={3} />);
    expect(container.querySelector('.line')).not.toBeNull();
  });

  it('applies the horizontal class by default and omits it when direction is vertical', () => {
    const { container: horizontal } = render(<Domino top={1} bottom={2} />);
    expect(horizontal.querySelector('.domino')?.classList.contains('horizontal')).toBe(true);

    const { container: vertical } = render(<Domino top={1} bottom={2} direction="vertical" />);
    expect(vertical.querySelector('.domino')?.classList.contains('horizontal')).toBe(false);
  });

  it('fires onClick when clicked and an onClick handler is provided', () => {
    const onClick = vi.fn();
    render(<Domino top={4} bottom={5} onClick={onClick} selectable />);

    fireEvent.click(screen.getByTestId('domino'));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('adds the clickable class only when selectable', () => {
    const { container } = render(<Domino top={4} bottom={5} onClick={() => {}} selectable />);
    expect(container.querySelector('.domino')?.classList.contains('clickable')).toBe(true);
  });
});
