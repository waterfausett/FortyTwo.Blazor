// Picking a seat when joining a match: the table again, bigger, with each taken seat's name and
// a button in each open one. Used by the lobby's Join flow and by a match page opened by someone
// who isn't seated (an invite link). Styles in SeatPicker.css.
import type { JSX } from 'react';
import { NameSkeleton } from './NameSkeleton';
import './SeatPicker.css';

// A table seen from above, indexed by seat position: the creator's seat (0) nearest you, then
// clockwise in turn order - the same layout the match screen uses (packages/client's table.ts), so
// the seat you pick here is where you'll sit relative to the others there. Partners sit across.
export const SEAT_SIDES = ['bottom', 'left', 'top', 'right'] as const;

// An open seat says who you'd partner with, since that's what picking a seat really decides
// (along with who plays before and after you).
export function SeatPicker({
  seats,
  disabled,
  loading = false,
  onPick,
}: {
  seats: (string | null)[];
  disabled: boolean;
  // The taken seats' names are still loading (a match page opened from an invite).
  loading?: boolean;
  onPick: (position: number) => void;
}): JSX.Element {
  return (
    <div className="seat-picker" role="group" aria-label="Pick a seat">
      <span className="seat-picker-table" aria-hidden="true" />
      {SEAT_SIDES.map((side, position) => {
        const name = seats[position];
        if (name != null) {
          return (
            <span key={side} className={`seat-picker-seat seat-picker-${side} is-seated`}>
              {loading ? <NameSkeleton /> : name}
            </span>
          );
        }
        const partner = seats[(position + 2) % 4];
        return (
          <button
            key={side}
            type="button"
            className={`seat-picker-seat seat-picker-${side}`}
            disabled={disabled}
            onClick={() => onPick(position)}
          >
            <span className="seat-picker-action">Sit here</span>
            <span className="seat-picker-hint">
              {partner == null ? 'open seat' : loading ? <>with <NameSkeleton width="3em" /></> : `with ${partner}`}
            </span>
          </button>
        );
      })}
    </div>
  );
}
