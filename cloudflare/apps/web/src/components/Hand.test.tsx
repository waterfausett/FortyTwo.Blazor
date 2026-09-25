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
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
});
