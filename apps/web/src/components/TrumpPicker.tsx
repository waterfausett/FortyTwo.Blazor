// The bidder's trump picker: every trump `availableTrumps` allows, with the three Low variants
// folded into a single "Low" tile. Picking Low opens a second step asking how doubles behave for
// the hand (high, low, or a suit of their own), since that's part of calling Low.
import type { JSX } from 'react';
import { useState } from 'react';
import type { Game } from '@fortytwo/rules';
import { LOW_TRUMPS, Suit, availableTrumps, isLow, lowDoublesToPrettyString, suitToPrettyString } from '@fortytwo/rules';
import { PipFace } from './PipFace';

export interface TrumpPickerProps {
  game: Game;
  onSelect: (suit: Suit) => void;
  disabled?: boolean;
}

const DOUBLES_DETAIL: Record<(typeof LOW_TRUMPS)[number], string> = {
  [Suit.Low]: 'Each double tops its suit (this is how doubles normally behave)',
  [Suit.LowDoublesLow]: 'Each double is the lowest of its suit',
  [Suit.LowDoublesOwnSuit]: 'Doubles form a suit, double-six highest',
};

export function TrumpPicker({ game, onSelect, disabled = false }: TrumpPickerProps): JSX.Element {
  const [choosingDoubles, setChoosingDoubles] = useState(false);
  const trumps = availableTrumps(game);
  const lowTrumps = trumps.filter(isLow);

  if (choosingDoubles) {
    return (
      <section className="trump-select-section" aria-label="Select trump">
        <p className="action-prompt">Low: how do doubles play?</p>
        <div className="trump-options">
          {lowTrumps.map((suit) => (
            <button
              key={suit}
              type="button"
              className="trump-tile trump-tile-wide"
              disabled={disabled}
              onClick={() => onSelect(suit)}
            >
              <span>{lowDoublesToPrettyString(suit)}</span>
              <span className="trump-tile-detail">{DOUBLES_DETAIL[suit as (typeof LOW_TRUMPS)[number]]}</span>
            </button>
          ))}
          <button type="button" className="trump-tile trump-tile-back" disabled={disabled} onClick={() => setChoosingDoubles(false)}>
            <span>Back</span>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="trump-select-section" aria-label="Select trump">
      <p className="action-prompt">Select a trump</p>
      <div className="trump-options">
        {trumps
          .filter((suit) => !isLow(suit))
          .map((suit) => (
            <button key={suit} type="button" className="trump-tile" disabled={disabled} onClick={() => onSelect(suit)}>
              <PipFace suit={suit} />
              <span>{suitToPrettyString(suit)}</span>
            </button>
          ))}
        {lowTrumps.length > 0 && (
          <button type="button" className="trump-tile" disabled={disabled} onClick={() => setChoosingDoubles(true)}>
            <PipFace suit={Suit.Low} />
            <span>Low</span>
          </button>
        )}
      </div>
    </section>
  );
}
