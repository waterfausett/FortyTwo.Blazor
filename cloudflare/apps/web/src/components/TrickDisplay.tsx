// Renders the trick being played in the middle of the table. Each played domino sits in front of
// the seat that played it (`slotSeats`, from match/table.ts) and slides in from that side when it
// lands; the domino that led gets a "Lead" tag, and once the trick is complete the winning domino
// is picked out. While `sweepTo` is set, the whole trick leaves the table the way `sweepMode`
// says (match/sweep.ts) - for every mode but `side`, each tile is measured and handed its own
// offsets (--gx/--gy to the winning tile, --dx/--dy to `sweepTarget`) for match.css to animate.
//
// Slot count is 4 normally and 3 for Suit.Low (trick.ts's `isTrickFull` treats a Low trick as
// full at 3 dominoes, the bidder's partner sitting out).
//
// Team point totals are NOT shown here - those are cumulative over completed tricks and live on
// TrickHistory's side piles; this component only ever deals with the one trick in play.
import type { CSSProperties, JSX } from 'react';
import { useLayoutEffect, useRef } from 'react';
import type { Trick } from '@fortytwo/rules';
import { Suit, isLow } from '@fortytwo/rules';
import type { Seat } from '../match/table';
import type { Point, SweepMode } from '../match/sweep';
import { centerOf, sweepDurationMs } from '../match/sweep';
import { Domino } from './Domino';

export interface TrickDisplayProps {
  trick: Trick;
  trump: Suit | null;
  // Seat that played each slot, in slot order. Defaults to a plain clockwise layout from the
  // bottom when the caller doesn't know who played what.
  slotSeats?: (Seat | null)[];
  // Slot index of the domino currently taking the trick - highlighted once the trick is complete.
  winningSlot?: number | null;
  sweepTo?: 'us' | 'them' | null;
  sweepMode?: SweepMode;
  // Viewport point the trick flies to; read once, as the sweep starts.
  sweepTarget?: (() => Point | null) | null;
}

const DEFAULT_SEATS: Seat[] = ['bottom', 'left', 'top', 'right'];

export function TrickDisplay({
  trick,
  trump,
  slotSeats,
  winningSlot = null,
  sweepTo = null,
  sweepMode = 'side',
  sweepTarget = null,
}: TrickDisplayProps): JSX.Element {
  const slotCount = isLow(trump) ? 3 : 4;
  const slots = trick.dominoes.slice(0, slotCount);
  const isComplete = slots.every((d) => d !== null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Measured before the first sweeping frame paints, while every tile still sits at rest. Keyed
  // on the sweep starting only: re-measuring on a later render would read mid-flight positions.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!sweepTo || !root || sweepMode === 'side') return;
    const tiles = [...root.querySelectorAll<HTMLElement>('.trick-slot')];
    const winnerTile = root.querySelector<HTMLElement>('.trick-slot-winner');
    const winner = winnerTile ? centerOf(winnerTile.getBoundingClientRect()) : null;
    const target = sweepTarget?.() ?? null;
    for (const tile of tiles) {
      const at = centerOf(tile.getBoundingClientRect());
      const gather = sweepMode === 'gather' && winner ? winner : at;
      const end = target ?? gather;
      tile.style.setProperty('--gx', `${gather.x - at.x}px`);
      tile.style.setProperty('--gy', `${gather.y - at.y}px`);
      tile.style.setProperty('--dx', `${end.x - at.x}px`);
      tile.style.setProperty('--dy', `${end.y - at.y}px`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sweepTarget is read once, at the start
  }, [sweepTo, sweepMode]);

  const sweepClass = sweepTo ? ` sweep-${sweepTo} sweep-mode-${sweepMode}` : '';
  const style = { '--sweep-ms': `${sweepDurationMs(sweepMode)}ms` } as CSSProperties;

  return (
    <div ref={rootRef} className={`current-trick${sweepClass}`} style={style} aria-label="Current trick">
      <div className="trick-slots">
        {slots.map((domino, index) => {
          const seat = slotSeats?.[index] ?? DEFAULT_SEATS[index];
          if (!domino) return <div key={`empty-${index}`} className={`trick-slot trick-slot-${seat} trick-slot-empty`} />;
          const isWinner = isComplete && winningSlot === index;
          return (
            <div
              key={domino.id}
              className={`trick-slot trick-slot-${seat} played-from-${seat}${isWinner ? ' trick-slot-winner' : ''}`}
            >
              <Domino top={domino.top} bottom={domino.bottom} direction="vertical" />
              {index === 0 && <span className="trick-lead-tag">Lead</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
