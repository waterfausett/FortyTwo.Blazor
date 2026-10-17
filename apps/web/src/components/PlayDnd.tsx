// The drag-and-drop context shared by the player's hand and the table. A domino is played by
// dragging it out of the hand and dropping it anywhere on the table, so the one `DndContext` has
// to enclose both: Match.tsx wraps the gameboard and the hand rail in `PlayDndContext`, renders
// the table itself as a `PlayDropZone`, and Hand.tsx follows drags with `useDndMonitor`.
//
// Auto-scroll is off: a dragged tile only ever travels between the hand and the table, both on
// screen, and letting dnd-kit scroll used to chase a tile dragged off the bottom of the page
// downward forever. Hand's drag ghost is also clamped to the viewport.
import type { ComponentPropsWithoutRef, JSX, ReactNode } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors } from '@dnd-kit/core';

export const PLAY_ZONE_ID = '__play-zone__';

// A press has to travel this far before it counts as a drag. Without it, every click and
// double-click (play / preselect) would start a zero-distance drag - briefly flashing the ghost
// and fading the tile.
const DRAG_ACTIVATION_DISTANCE_PX = 5;

export function PlayDndContext({ children }: { children: ReactNode }): JSX.Element {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE_PX } }),
    useSensor(KeyboardSensor)
  );
  return (
    <DndContext sensors={sensors} autoScroll={false}>
      {children}
    </DndContext>
  );
}

// A `div` that plays whatever domino is dropped on it. While `live` (this player's turn), a drag
// hovering over it adds match.css's `.play-zone-over`; a drop that isn't live is ignored by Hand.
export function PlayDropZone({
  live,
  className,
  ...rest
}: { live: boolean } & ComponentPropsWithoutRef<'div'>): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: PLAY_ZONE_ID });
  return <div ref={setNodeRef} className={`${className ?? ''}${live && isOver ? ' play-zone-over' : ''}`} {...rest} />;
}
