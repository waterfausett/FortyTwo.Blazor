// The bidder's trump picker: every trump `availableTrumps` allows, with the three Low variants
// folded into a single "Low" tile. Picking Low opens a second step asking how doubles behave for
// the hand (high, low, or a suit of their own), since that's part of calling Low.
import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import type { Game } from '@fortytwo/rules';
import { LOW_TRUMPS, Suit, availableTrumps, isLow, lowDoublesToPrettyString, suitToPrettyString } from '@fortytwo/rules';
import { DOUBLES_DETAIL } from '@fortytwo/client';
import { PipFace } from './PipFace';

export interface TrumpPickerProps {
  game: Game;
  onSelect: (suit: Suit) => void;
  disabled?: boolean;
  // The trump a hint suggests, outlined (on the Low tile for any Low variant).
  suggested?: Suit | null;
  // Shown beside the prompt: the Hint button, or its answer.
  hint?: ReactNode;
}

export function TrumpPicker({ game, onSelect, disabled = false, suggested = null, hint = null }: TrumpPickerProps): JSX.Element {
  const [choosingDoubles, setChoosingDoubles] = useState(false);
  const trumps = availableTrumps(game);
  const lowTrumps = trumps.filter(isLow);

  if (choosingDoubles) {
    return (
      <section className="trump-select-section" aria-label="Select trump">
        <div className="action-prompt-row">
          <p className="action-prompt">Low: how do doubles play?</p>
          {hint}
        </div>
        <div className="trump-options">
          {lowTrumps.map((suit) => (
            <button
              key={suit}
              type="button"
              className={`trump-tile trump-tile-wide${suit === suggested ? ' trump-tile-suggested' : ''}`}
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
      <div className="action-prompt-row">
        <p className="action-prompt">Select a trump</p>
        {hint}
      </div>
      <div className="trump-options">
        {trumps
          .filter((suit) => !isLow(suit))
          .map((suit) => (
            <button key={suit} type="button" className={`trump-tile${suit === suggested ? ' trump-tile-suggested' : ''}`} disabled={disabled} onClick={() => onSelect(suit)}>
              <PipFace suit={suit} />
              <span>{suitToPrettyString(suit)}</span>
            </button>
          ))}
        {lowTrumps.length > 0 && (
          <button
            type="button"
            className={`trump-tile${suggested !== null && isLow(suggested) ? ' trump-tile-suggested' : ''}`}
            disabled={disabled}
            onClick={() => setChoosingDoubles(true)}
          >
            <PipFace suit={Suit.Low} />
            <span>Low</span>
          </button>
        )}
      </div>
    </section>
  );
}
