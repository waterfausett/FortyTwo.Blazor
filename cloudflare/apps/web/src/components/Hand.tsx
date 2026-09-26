// The player's own hand: draggable/reorderable dominoes plus a dedicated "play zone" droppable
// representing the trick area. Replaces the `SortGroup`/`BlazorSortableJS`-driven hand section of
// FortyTwo/Client/Pages/Match.razor. Uses @dnd-kit/core's `DndContext` + `useDraggable` (for
// reordering hand tiles among themselves) and `useDroppable` (both per-tile, so dropping one
// domino onto another reorders, and for the dedicated play zone, so dropping onto it plays)
// rather than @dnd-kit/sortable, matching the brief's explicit "DndContext/useDraggable" framing.
//
// `onPlay(domino)` fires three ways, matching the brief's "on click/drop onto the trick area" plus
// the double-click/preselect addition below:
//   - clicking a tile directly (only when `selectable`)
//   - dragging a tile and dropping it onto the play zone (also gated on `selectable`)
//   - double-clicking a tile: plays immediately if `selectable`; otherwise queues it as a
//     preselection that auto-plays (after a brief flash - PRESELECT_AUTO_PLAY_DELAY_MS) once it
//     becomes this player's turn, gated by the caller-supplied `isValidPlay`
// Reordering (dropping one tile onto another) is local UI state only, and - unlike the play
// actions above - is NEVER gated on `selectable`: a player should be able to rearrange their own
// hand for reference at any time, not just on their turn. It doesn't call the server either,
// mirroring the old app's `OnSort` handler, which only reordered `Player.Dominos` client-side.
import type { CSSProperties, JSX, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { DndContext, useDraggable, useDroppable, type DragEndEvent } from '@dnd-kit/core';
import type { Domino as DominoType } from '@fortytwo/rules';
import { Domino } from './Domino';

export interface HandProps {
  dominoes: DominoType[];
  selectable: boolean;
  onPlay: (domino: DominoType) => void;
  // Reports whether double-clicking `domino` right now (before it's this player's turn) is worth
  // queuing up as an auto-play - see `PRESELECT_AUTO_PLAY_DELAY_MS` below. Defaults to "anything
  // goes" so callers that don't care about follow-suit/etc. validation aren't forced to supply one.
  isValidPlay?: (domino: DominoType) => boolean;
}

const PLAY_ZONE_ID = '__play-zone__';

// How long a preselected domino "flashes" as pending once it's actually this player's turn,
// before it auto-submits - a small window to notice and react (e.g. by manually clicking a
// different tile, which plays it immediately and pre-empts the queued auto-play) rather than it
// firing the instant the turn arrives.
const PRESELECT_AUTO_PLAY_DELAY_MS = 400;

function DraggableDomino({
  domino,
  selectable,
  preselected,
  onClick,
  onDoubleClick,
}: {
  domino: DominoType;
  selectable: boolean;
  preselected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}): JSX.Element {
  // Reordering (drag-to-swap) is always available, regardless of whose turn it is - only the
  // play-zone-drop *action* (handled in handleDragEnd below) needs to stay turn-gated.
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({
    id: domino.id,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: domino.id });

  const style: CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      style={style}
      className={`hand-tile${isOver ? ' hand-tile-over' : ''}`}
      {...listeners}
      {...attributes}
    >
      <Domino
        top={domino.top}
        bottom={domino.bottom}
        selectable={selectable}
        preselected={preselected}
        onClick={selectable ? onClick : undefined}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}

function PlayZone({ children }: { children: ReactNode }): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: PLAY_ZONE_ID });
  return (
    <div ref={setNodeRef} className={`hand-play-zone${isOver ? ' hand-play-zone-over' : ''}`}>
      {children}
    </div>
  );
}

export function Hand({ dominoes, selectable, onPlay, isValidPlay = () => true }: HandProps): JSX.Element {
  const [order, setOrder] = useState<DominoType[]>(dominoes);
  const [syncedDominoes, setSyncedDominoes] = useState<DominoType[]>(dominoes);
  // The single domino (by id) queued to auto-play once it becomes this player's turn - set by
  // double-clicking a tile before `selectable` is true. Only one at a time: double-clicking a
  // different tile replaces it, matching a player only ever getting to make one move per turn.
  const [preselectedId, setPreselectedId] = useState<string | null>(null);

  // Latest-value refs so the auto-play effect below can depend on just `[selectable,
  // preselectedId]` - `order` gets a new array identity on every reorder (unrelated to whether a
  // preselection should fire) and `onPlay` is a fresh closure from Match.tsx on every render, so
  // depending on either directly would restart/misfire the auto-play timer constantly.
  const orderRef = useRef(order);
  orderRef.current = order;
  const onPlayRef = useRef(onPlay);
  onPlayRef.current = onPlay;

  // React's recommended "adjusting state when a prop changes" pattern (a render-phase state
  // update) rather than a useEffect - avoids an extra commit+re-render cycle for what's really a
  // derived reset. `dominoes` is reference-stable across unrelated re-renders (Match.tsx's
  // `getPlayerView(match, myPlayerId)` reads `hand.dominoes` straight through from the current
  // `match` object, so the array reference only changes when `useMatchSocket` actually delivers a
  // new MatchState) - so this only resyncs local reorder state on a genuine hand change: a new
  // deal, a domino removed after a play, etc. The local order is a display-only convenience,
  // never the source of truth.
  if (dominoes !== syncedDominoes) {
    setSyncedDominoes(dominoes);
    setOrder(dominoes);
    setPreselectedId(null);
  }

  // Fires the preselected domino a beat after it's actually this player's turn - see
  // PRESELECT_AUTO_PLAY_DELAY_MS's comment for why the delay exists. Cancelled (via the cleanup)
  // whenever the preselection changes or is cleared - including by `playDomino` below, which
  // clears it as soon as ANY domino is actually played (manually or via a previous firing of this
  // same timer).
  useEffect(() => {
    if (!selectable || preselectedId === null) return;
    const timer = setTimeout(() => {
      const domino = orderRef.current.find((d) => d.id === preselectedId);
      setPreselectedId(null);
      if (domino) onPlayRef.current(domino);
    }, PRESELECT_AUTO_PLAY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [selectable, preselectedId]);

  // The one path every actual play goes through (click, double-click-while-selectable, or
  // dropping onto the play zone) - clearing any unrelated pending preselection here means a
  // manual play always pre-empts a queued auto-play instead of racing it.
  function playDomino(domino: DominoType): void {
    setPreselectedId(null);
    onPlay(domino);
  }

  function handleDoubleClick(domino: DominoType): void {
    if (selectable) {
      playDomino(domino);
      return;
    }
    setPreselectedId((current) => {
      if (current === domino.id) return null; // toggle off
      return isValidPlay(domino) ? domino.id : current;
    });
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over) return;

    if (over.id === PLAY_ZONE_ID) {
      if (!selectable) return;
      const dragged = order.find((d) => d.id === active.id);
      if (dragged) playDomino(dragged);
      return;
    }

    if (over.id === active.id) return;

    const fromIndex = order.findIndex((d) => d.id === active.id);
    const toIndex = order.findIndex((d) => d.id === over.id);
    if (fromIndex === -1 || toIndex === -1) return;

    const reordered = [...order];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    setOrder(reordered);
  }

  return (
    <DndContext onDragEnd={handleDragEnd}>
      <PlayZone>Drop here to play</PlayZone>
      <div className="hand domino-container" data-testid="hand">
        {order.map((domino) => (
          <DraggableDomino
            key={domino.id}
            domino={domino}
            selectable={selectable}
            preselected={domino.id === preselectedId}
            onClick={() => playDomino(domino)}
            onDoubleClick={() => handleDoubleClick(domino)}
          />
        ))}
      </div>
    </DndContext>
  );
}
