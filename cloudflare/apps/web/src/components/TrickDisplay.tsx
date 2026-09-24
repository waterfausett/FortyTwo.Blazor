// Renders the current trick's 4 (or 3, for Suit.Low - matching trick.ts's `isTrickFull`, which
// treats a Low-trump trick as full at 3 dominoes) slots around a table center, one `Domino` per
// non-null slot rendered in the "vertical" (unrotated) orientation Match.razor used for trick
// piles. Reuses chip.css's existing `.custom-chip`/`.badge` classes for the running point total,
// matching the old page's `<Chip Context="ContextualClass.Info"><Label>Points</Label>
// <Badge>...</Badge></Chip>` next to trick piles - no new CSS. Replaces the
// `current-trick`/`gameboard` portion of FortyTwo/Client/Pages/Match.razor.
import type { JSX } from 'react';
import type { Trick } from '@fortytwo/rules';
import { dominoValue, Suit } from '@fortytwo/rules';
import { Domino } from './Domino';

export interface TrickDisplayProps {
  trick: Trick;
  trump: Suit | null;
}

export function TrickDisplay({ trick, trump }: TrickDisplayProps): JSX.Element {
  const slotCount = trump === Suit.Low ? 3 : 4;
  const slots = trick.dominoes.slice(0, slotCount);
  const points = slots.reduce((sum, d) => sum + (d ? dominoValue(d) : 0), 0);

  return (
    <div className="current-trick" aria-label="Current trick">
      <span className="custom-chip custom-chip-info trick-points">
        Points
        <span className="badge badge-info">{points}</span>
      </span>
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
