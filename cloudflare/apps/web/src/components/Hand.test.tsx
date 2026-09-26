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

  // Reads a rendered tile's (top, bottom) pips back out, to identify which domino ended up in
  // which position after a reorder-preserving re-render (dominoes carry no visible id in the DOM).
  function pipsOf(tile: HTMLElement): [number, number] {
    const [topEl, bottomEl] = tile.querySelectorAll('[data-value]');
    return [Number(topEl.getAttribute('data-value')), Number(bottomEl.getAttribute('data-value'))];
  }

  // Regression test: `dominoes` gets a new array on every server broadcast (see the module
  // header), including the one right after THIS player's own play, which is a genuine hand change
  // (a domino actually leaves the hand) and so must legitimately update `order` - but the server's
  // own hand array keeps its ORIGINAL (dealt) relative order when removing a played domino
  // (matchEngine.ts's `playDomino` splices the dealt-order array, with no idea the player had
  // locally dragged their remaining tiles into a different arrangement). Naively resetting local
  // `order` to that server array on every such change snapped the whole hand back to dealt order
  // after every single play, discarding a rearrangement the player was actively relying on.
  it('keeps the local order of remaining dominoes after one is removed (a play), rather than reverting to server order', () => {
    const [d1, d2, d3] = DOMINOES;
    // Initial `dominoes` stands in for the player's current (already-rearranged) view - e.g. they
    // swapped d1 and d2 from a dealt order of [d1, d2, d3].
    const { rerender } = render(<Hand dominoes={[d2, d1, d3]} selectable={false} onPlay={() => {}} />);

    // Broadcast after d3 is played: the remaining hand keeps ITS OWN dealt order, [d1, d2] - not
    // the player's locally-swapped view.
    rerender(<Hand dominoes={[d1, d2]} selectable={false} onPlay={() => {}} />);

    const tiles = screen.getAllByTestId('domino');
    expect(tiles).toHaveLength(2);
    // Must still show d2 before d1 (the player's swap survives), not reset to the server's [d1, d2].
    expect(pipsOf(tiles[0])).toEqual([d2.top, d2.bottom]);
    expect(pipsOf(tiles[1])).toEqual([d1.top, d1.bottom]);
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

    // Every socket message from useMatchSocket is a fresh `JSON.parse`, so `dominoes` gets a new
    // array (and new element objects) on EVERY broadcast to the match - another player's bid,
    // this player's own trump selection, etc. - even when this player's hand didn't change at
    // all. Hand.tsx must not treat "new object reference" as "genuine hand change", or it wipes
    // out local-only state (reorder, preselection) on any unrelated broadcast.
    it('keeps a preselection across a re-render with a content-equal but reference-different dominoes array', () => {
      const onPlay = vi.fn();
      const { rerender } = render(
        <Hand dominoes={DOMINOES} selectable={false} onPlay={onPlay} isValidPlay={() => true} />
      );

      fireEvent.doubleClick(screen.getAllByTestId('domino')[0]);
      expect(screen.getAllByTestId('domino')[0].classList.contains('preselected')).toBe(true);

      // Same ids/values, but brand-new array and element objects - simulating a JSON round-trip.
      const freshDominoes = DOMINOES.map((d) => ({ ...d }));
      rerender(<Hand dominoes={freshDominoes} selectable={false} onPlay={onPlay} isValidPlay={() => true} />);

      expect(screen.getAllByTestId('domino')[0].classList.contains('preselected')).toBe(true);
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
