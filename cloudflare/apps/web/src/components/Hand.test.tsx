// Hand.tsx renders the player's own dominoes inside a @dnd-kit/core DndContext (useDraggable
// for reordering within the hand, useDroppable for a dedicated "play zone" representing dropping
// onto the trick), firing `onPlay(domino)` on click (when selectable) or on a drop onto the play
// zone. Replaces the `SortGroup`/`BlazorSortableJS`-driven hand section of
// FortyTwo/Client/Pages/Match.razor.
//
// jsdom doesn't implement ResizeObserver (used internally by @dnd-kit/core's droppable-rect
// measuring) - this is the "known test-infra gap" the brief calls out for dnd-kit specifically;
// without this polyfill, mounting a DndContext throws `ReferenceError: ResizeObserver is not
// defined`. A minimal no-op stub is enough since these tests only exercise click-to-play and
// component wiring, not real pointer-drag physics (real drag-and-drop is not meaningfully
// testable under jsdom without a much heavier simulation harness).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDomino } from '@fortytwo/rules';
import { Hand } from './Hand';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    // DOM lib declares the real ResizeObserver's full constructor/instance shape; this stub is
    // deliberately narrower (a jsdom-only polyfill, not a spec-complete implementation), hence
    // the cast rather than a direct assignment.
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  cleanup();
});

const DOMINOES = [createDomino(1, 2), createDomino(3, 4), createDomino(5, 6)];

describe('Hand', () => {
  it('renders one Domino per hand tile', () => {
    render(<Hand dominoes={DOMINOES} selectable onPlay={() => {}} />);
    expect(screen.getAllByTestId('domino')).toHaveLength(3);
  });

  it('fires onPlay with the clicked domino when selectable', () => {
    const onPlay = vi.fn();
    render(<Hand dominoes={DOMINOES} selectable onPlay={onPlay} />);

    fireEvent.click(screen.getAllByTestId('domino')[1]);

    expect(onPlay).toHaveBeenCalledWith(DOMINOES[1]);
  });

  it('does not fire onPlay on click when not selectable', () => {
    const onPlay = vi.fn();
    render(<Hand dominoes={DOMINOES} selectable={false} onPlay={onPlay} />);

    fireEvent.click(screen.getAllByTestId('domino')[0]);

    expect(onPlay).not.toHaveBeenCalled();
  });

  it('does not mark dominoes as clickable when not selectable', () => {
    render(<Hand dominoes={DOMINOES} selectable={false} onPlay={() => {}} />);

    for (const tile of screen.getAllByTestId('domino')) {
      expect(tile.classList.contains('clickable')).toBe(false);
    }
  });

  // A player should be able to reorder their hand for their own reference at any time, not just
  // on their turn - `useDraggable`'s `disabled` flag (mirrored onto the DOM as `aria-disabled` -
  // see @dnd-kit/core's core.cjs.development.js:3432) used to be wired straight to `!selectable`,
  // which silently dropped drag listeners (`listeners: disabled ? undefined : listeners`)
  // whenever it wasn't this player's turn.
  it('keeps hand tiles draggable (not aria-disabled) even when not selectable', () => {
    render(<Hand dominoes={DOMINOES} selectable={false} onPlay={() => {}} />);

    for (const tile of screen.getAllByTestId('domino').map((d) => d.closest('.hand-tile')!)) {
      expect(tile.getAttribute('aria-disabled')).toBe('false');
    }
  });

  describe('double-click to play / preselect', () => {
    it('fires onPlay via double-click when selectable, same as a single click', () => {
      const onPlay = vi.fn();
      render(<Hand dominoes={DOMINOES} selectable onPlay={onPlay} />);

      fireEvent.doubleClick(screen.getAllByTestId('domino')[1]);

      expect(onPlay).toHaveBeenCalledWith(DOMINOES[1]);
    });

    it('preselects a domino on double-click when not selectable and the move is valid', () => {
      const onPlay = vi.fn();
      render(<Hand dominoes={DOMINOES} selectable={false} onPlay={onPlay} isValidPlay={() => true} />);

      fireEvent.doubleClick(screen.getAllByTestId('domino')[0]);

      // The glow lives on the `.domino` element itself (matching domino.css's existing
      // `.domino.preselected` rule) - not a wrapper class - since `.horizontal`'s rotate+negative-
      // margin hack means a wrapper's own layout box doesn't line up with where the domino
      // actually renders.
      expect(screen.getAllByTestId('domino')[0].classList.contains('preselected')).toBe(true);
      expect(onPlay).not.toHaveBeenCalled();
    });

    it('does not preselect a domino the caller reports as an invalid move', () => {
      const onPlay = vi.fn();
      render(<Hand dominoes={DOMINOES} selectable={false} onPlay={onPlay} isValidPlay={() => false} />);

      fireEvent.doubleClick(screen.getAllByTestId('domino')[0]);

      expect(screen.getAllByTestId('domino')[0].classList.contains('preselected')).toBe(false);
      expect(onPlay).not.toHaveBeenCalled();
    });

    it('clears a preselection when the same tile is double-clicked again', () => {
      render(<Hand dominoes={DOMINOES} selectable={false} onPlay={() => {}} isValidPlay={() => true} />);
      const tile = screen.getAllByTestId('domino')[0];

      fireEvent.doubleClick(tile);
      fireEvent.doubleClick(tile);

      expect(tile.classList.contains('preselected')).toBe(false);
    });

    it('moves the preselection to a newly double-clicked tile', () => {
      render(<Hand dominoes={DOMINOES} selectable={false} onPlay={() => {}} isValidPlay={() => true} />);
      const tiles = screen.getAllByTestId('domino');

      fireEvent.doubleClick(tiles[0]);
      fireEvent.doubleClick(tiles[1]);

      expect(tiles[0].classList.contains('preselected')).toBe(false);
      expect(tiles[1].classList.contains('preselected')).toBe(true);
    });

    it('auto-plays a preselected domino shortly after it becomes this player\'s turn', () => {
      vi.useFakeTimers();
      try {
        const onPlay = vi.fn();
        const { rerender } = render(
          <Hand dominoes={DOMINOES} selectable={false} onPlay={onPlay} isValidPlay={() => true} />
        );
        fireEvent.doubleClick(screen.getAllByTestId('domino')[0]);

        rerender(<Hand dominoes={DOMINOES} selectable onPlay={onPlay} isValidPlay={() => true} />);

        // Not immediate - a brief flash/confirmation window before it actually submits.
        expect(onPlay).not.toHaveBeenCalled();

        act(() => {
          vi.advanceTimersByTime(400);
        });

        expect(onPlay).toHaveBeenCalledWith(DOMINOES[0]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
