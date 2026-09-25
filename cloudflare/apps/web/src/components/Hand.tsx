// The player's own hand: draggable/reorderable dominoes plus a dedicated "play zone" droppable
// representing the trick area. Replaces the `SortGroup`/`BlazorSortableJS`-driven hand section of
// FortyTwo/Client/Pages/Match.razor. Uses @dnd-kit/core's `DndContext` + `useDraggable` (for
// reordering hand tiles among themselves) and `useDroppable` (both per-tile, so dropping one
// domino onto another reorders, and for the dedicated play zone, so dropping onto it plays)
// rather than @dnd-kit/sortable, matching the brief's explicit "DndContext/useDraggable" framing.
//
// `onPlay(domino)` fires two ways, matching the brief's "on click/drop onto the trick area":
//   - clicking a tile directly (only when `selectable`)
//   - dragging a tile and dropping it onto the play zone (also gated on `selectable`)
// Reordering (dropping one tile onto another) is local UI state only - it doesn't call the
// server, mirroring the old app's `OnSort` handler, which only reordered `Player.Dominos`
// client-side.
import type { CSSProperties, JSX, ReactNode } from 'react';
import { useState } from 'react';
import { DndContext, useDraggable, useDroppable, type DragEndEvent } from '@dnd-kit/core';
import type { Domino as DominoType } from '@fortytwo/rules';
import { Domino } from './Domino';

export interface HandProps {
  dominoes: DominoType[];
  selectable: boolean;
  onPlay: (domino: DominoType) => void;
}

const PLAY_ZONE_ID = '__play-zone__';

function DraggableDomino({
  domino,
  selectable,
  onPlay,
}: {
  domino: DominoType;
  selectable: boolean;
  onPlay: (domino: DominoType) => void;
}): JSX.Element {
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({
    id: domino.id,
    disabled: !selectable,
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: domino.id, disabled: !selectable });

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
        onClick={selectable ? () => onPlay(domino) : undefined}
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

export function Hand({ dominoes, selectable, onPlay }: HandProps): JSX.Element {
  const [order, setOrder] = useState<DominoType[]>(dominoes);
  const [syncedDominoes, setSyncedDominoes] = useState<DominoType[]>(dominoes);

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
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over) return;

    if (over.id === PLAY_ZONE_ID) {
      if (!selectable) return;
      const dragged = order.find((d) => d.id === active.id);
      if (dragged) onPlay(dragged);
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
          <DraggableDomino key={domino.id} domino={domino} selectable={selectable} onPlay={onPlay} />
        ))}
      </div>
    </DndContext>
  );
}
