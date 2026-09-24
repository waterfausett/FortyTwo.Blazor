// Renders the CURRENT (in-progress) trick's 4 (or 3, for Suit.Low - matching trick.ts's
// `isTrickFull`, which treats a Low-trump trick as full at 3 dominoes) slots, one `Domino` per
// non-null slot rendered in the "vertical" (unrotated) orientation Match.razor used for trick
// piles. Replaces the `current-trick` portion of FortyTwo/Client/Pages/Match.razor's `gameboard`.
//
// Fix note (post-review): this component used to also render a "Points" chip summing the raw pip
// values of the in-progress trick's dominoes - that was the WRONG metric. The real
// Match.razor:132,143 "Points" badges show each team's CUMULATIVE value of already-COMPLETED
// tricks this game (`CurrentGame.Tricks.Where(x => x.Team == ...).Sum(x => x.Value)`), not
// anything about the trick still being played. That per-team cumulative total needs `game.tricks`
// (completed tricks) and each player's team, neither of which this component receives - Match.tsx
// now computes and renders those two badges itself (see its `teamTrickPoints` helper), positioned
// in the `.gameboard`'s `.player-team-tricks`/`.opponent-tricks` panels flanking this component,
// matching the real page's layout (ported into `styles/match.css`).
import type { JSX } from 'react';
import type { Trick } from '@fortytwo/rules';
import { Suit } from '@fortytwo/rules';
import { Domino } from './Domino';

export interface TrickDisplayProps {
  trick: Trick;
  trump: Suit | null;
}

export function TrickDisplay({ trick, trump }: TrickDisplayProps): JSX.Element {
  const slotCount = trump === Suit.Low ? 3 : 4;
  const slots = trick.dominoes.slice(0, slotCount);

  return (
    <div className="current-trick" aria-label="Current trick">
      <div className="trick-slots">
        {slots.map((domino, index) =>
          domino ? (
            <div key={domino.id} className={`trick-slot trick-slot-${index}`}>
              <Domino top={domino.top} bottom={domino.bottom} direction="vertical" />
            </div>
          ) : (
            <div key={`empty-${index}`} className={`trick-slot trick-slot-${index} trick-slot-empty`} />
          )
        )}
      </div>
    </div>
  );
}
