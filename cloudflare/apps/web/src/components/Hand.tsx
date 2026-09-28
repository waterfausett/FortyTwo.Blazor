// The player's own hand: draggable/reorderable dominoes. Replaces the
// `SortGroup`/`BlazorSortableJS`-driven hand section of FortyTwo/Client/Pages/Match.razor. Uses
// @dnd-kit/core's `useDraggable` + per-tile `useDroppable` (so dropping one domino onto another
// reorders) rather than @dnd-kit/sortable. The `DndContext` itself lives above this component
// (PlayDnd.tsx's `PlayDndContext`), because the drop target that plays a domino is the table, not
// anything in the hand; Hand follows drags through `useDndMonitor`, so it must be rendered inside
// that context.
//
// `onPlay(domino)` fires three ways, matching the brief's "on click/drop onto the trick area" plus
// the double-click/preselect addition below:
//   - clicking a tile directly (only when `selectable`)
//   - dragging a tile and dropping it onto the table (also gated on `selectable`)
//   - double-clicking a tile: plays immediately if `selectable`; otherwise queues it as a
//     preselection that auto-plays (after a brief flash - PRESELECT_AUTO_PLAY_DELAY_MS) once it
//     becomes this player's turn, gated by the caller-supplied `isValidPlay`
// Reordering (dropping one tile onto another) is local UI state only, and - unlike the play
// actions above - is NEVER gated on `selectable`: a player should be able to rearrange their own
// hand for reference at any time, not just on their turn. It doesn't call the server either,
// mirroring the old app's `OnSort` handler, which only reordered `Player.Dominos` client-side.
//
// While dragging, the tile itself never moves: a ghost copy follows the pointer in a
// `DragOverlay` (position: fixed, so it can't stretch the page), and the original stays in the
// hand as a faded placeholder. Moving the original used to let a tile be dragged past the bottom
// of the page, growing it - with dnd-kit's auto-scroll chasing it downward forever. Auto-scroll is
// off (see PlayDnd.tsx), and the ghost is clamped to the viewport.
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  DragOverlay,
  useDndMonitor,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from '@dnd-kit/core';
import type { Domino as DominoType } from '@fortytwo/rules';
import { Domino } from './Domino';
import { PLAY_ZONE_ID } from './PlayDnd';

export interface HandProps {
  dominoes: DominoType[];
  selectable: boolean;
  onPlay: (domino: DominoType) => void;
  // Reports whether double-clicking `domino` right now (before it's this player's turn) is worth
  // queuing up as an auto-play - see `PRESELECT_AUTO_PLAY_DELAY_MS` below. Defaults to "anything
  // goes" so callers that don't care about follow-suit/etc. validation aren't forced to supply one.
  isValidPlay?: (domino: DominoType) => boolean;
}

// How long a preselected domino "flashes" as pending once it's actually this player's turn,
// before it auto-submits - a small window to notice and react (e.g. by manually clicking a
// different tile, which plays it immediately and pre-empts the queued auto-play) rather than it
// firing the instant the turn arrives.
const PRESELECT_AUTO_PLAY_DELAY_MS = 400;

// Keeps the drag ghost fully on screen.
const restrictToViewport: Modifier = ({ transform, draggingNodeRect, windowRect }) => {
  if (!draggingNodeRect || !windowRect) return transform;
  const minX = windowRect.left - draggingNodeRect.left;
  const maxX = windowRect.left + windowRect.width - draggingNodeRect.right;
  const minY = windowRect.top - draggingNodeRect.top;
  const maxY = windowRect.top + windowRect.height - draggingNodeRect.bottom;
  return {
    ...transform,
    x: Math.min(Math.max(transform.x, minX), maxX),
    y: Math.min(Math.max(transform.y, minY), maxY),
  };
};

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
  // drop-on-the-table *action* (handled in handleDragEnd below) needs to stay turn-gated.
  // No `transform` applied here - the DragOverlay ghost is what moves; this stays put.
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({ id: domino.id });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: domino.id });

  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      className={`hand-tile${isOver && !isDragging ? ' hand-tile-over' : ''}${isDragging ? ' hand-tile-dragging' : ''}`}
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

// Identifies which actual dominoes are in the hand, ignoring array/object identity - every
// message from useMatchSocket is a fresh `JSON.parse`, so `dominoes` gets a brand-new array (and
// brand-new element objects) on EVERY broadcast to the match, not just ones where this player's
// hand changed. Comparing this signature (rather than `dominoes` itself) is what lets Hand tell
// "an unrelated broadcast arrived" apart from "a domino was actually dealt or played".
function handSignature(dominoes: DominoType[]): string {
  return dominoes.map((d) => d.id).join(',');
}

// Reconciles a possibly-manually-reordered `previousOrder` against a fresh `dominoes` list from
// the server on a genuine hand change. The server's own array order is NOT authoritative for
// display: `matchEngine.ts`'s `playDomino` removes a played domino via `splice` on the hand's
// ORIGINAL (dealt) order, with no idea a player dragged their remaining tiles into a different
// arrangement - so naively resetting to `dominoes` on every change (the previous approach) snapped
// the whole hand back to dealt order after every single play. Instead: dominoes still present keep
// their existing relative position from `previousOrder` (preserving the player's arrangement
// across the one domino that just left their hand), and any domino NOT in `previousOrder` (a fresh
// deal, where `previousOrder` is empty) is appended in the server-supplied order.
function reconcileHandOrder(previousOrder: DominoType[], dominoes: DominoType[]): DominoType[] {
  const nextIds = new Set(dominoes.map((d) => d.id));
  const kept = previousOrder.filter((d) => nextIds.has(d.id));
  const keptIds = new Set(kept.map((d) => d.id));
  const added = dominoes.filter((d) => !keptIds.has(d.id));
  return [...kept, ...added];
}

export function Hand({ dominoes, selectable, onPlay, isValidPlay = () => true }: HandProps): JSX.Element {
  const [order, setOrder] = useState<DominoType[]>(dominoes);
  const [syncedSignature, setSyncedSignature] = useState<string>(() => handSignature(dominoes));
  // The single domino (by id) queued to auto-play once it becomes this player's turn - set by
  // double-clicking a tile before `selectable` is true. Only one at a time: double-clicking a
  // different tile replaces it, matching a player only ever getting to make one move per turn.
  const [preselectedId, setPreselectedId] = useState<string | null>(null);
  // The tile being dragged (drawn as the DragOverlay ghost), and whether dropping it right now
  // would play it (it's over the table on this player's turn).
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropWillPlay, setDropWillPlay] = useState(false);

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
  // derived reset. Compared by content signature, not object identity: `dominoes` gets a new
  // array reference on every `useMatchSocket` broadcast (each is a fresh `JSON.parse`), including
  // broadcasts unrelated to this player's hand (another player's bid, this player's own trump
  // selection, etc.) - reference equality would treat every one of those as a "genuine hand
  // change" and wipe out local-only state below. The signature only changes on an actual deal or
  // a domino leaving the hand after a play - and even then, `reconcileHandOrder` preserves the
  // player's own arrangement of whatever dominoes remain rather than snapping back to server
  // order. The local order is a display-only convenience, never the source of truth.
  const signature = handSignature(dominoes);
  if (signature !== syncedSignature) {
    setSyncedSignature(signature);
    setOrder(reconcileHandOrder(order, dominoes));
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
  // dropping onto the table) - clearing any unrelated pending preselection here means a
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

  function handleDragStart(event: DragStartEvent): void {
    setDraggingId(String(event.active.id));
    setDropWillPlay(false);
  }

  function handleDragOver(event: DragOverEvent): void {
    setDropWillPlay(selectable && event.over?.id === PLAY_ZONE_ID);
  }

  function handleDragEnd(event: DragEndEvent): void {
    setDraggingId(null);
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

  useDndMonitor({
    onDragStart: handleDragStart,
    onDragOver: handleDragOver,
    onDragEnd: handleDragEnd,
    onDragCancel: () => setDraggingId(null),
  });

  const draggingDomino = draggingId == null ? null : (order.find((d) => d.id === draggingId) ?? null);

  return (
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
      {/* Inside the hand container so the ghost inherits its tile sizing. A tile dropped on the
          table is played, so it shouldn't first glide back to its slot in the hand. */}
      <DragOverlay modifiers={[restrictToViewport]} dropAnimation={dropWillPlay ? null : undefined}>
        {draggingDomino && (
          <div className="hand-drag-ghost">
            <Domino top={draggingDomino.top} bottom={draggingDomino.bottom} />
          </div>
        )}
      </DragOverlay>
    </div>
  );
}
