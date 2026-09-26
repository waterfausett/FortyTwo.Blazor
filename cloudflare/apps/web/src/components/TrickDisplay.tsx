// Renders the trick being played in the middle of the table. Each played domino sits in front of
// the seat that played it (`slotSeats`, from match/table.ts) and slides in from that side when it
// lands; the domino that led gets a "Lead" tag, and once the trick is complete the winning domino
// is picked out. While `sweepTo` is set, the whole trick slides off toward that team's pile.
//
// Slot count is 4 normally and 3 for Suit.Low (trick.ts's `isTrickFull` treats a Low trick as
// full at 3 dominoes, the bidder's partner sitting out).
//
// Team point totals are NOT shown here - those are cumulative over completed tricks and live on
// TrickHistory's side piles; this component only ever deals with the one trick in play.
import type { JSX } from 'react';
import type { Trick } from '@fortytwo/rules';
import { Suit } from '@fortytwo/rules';
import type { Seat } from '../match/table';
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
}

const DEFAULT_SEATS: Seat[] = ['bottom', 'left', 'top', 'right'];

export function TrickDisplay({ trick, trump, slotSeats, winningSlot = null, sweepTo = null }: TrickDisplayProps): JSX.Element {
  const slotCount = trump === Suit.Low ? 3 : 4;
  const slots = trick.dominoes.slice(0, slotCount);
  const isComplete = slots.every((d) => d !== null);

  return (
    <div className={`current-trick${sweepTo ? ` sweep-${sweepTo}` : ''}`} aria-label="Current trick">
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
