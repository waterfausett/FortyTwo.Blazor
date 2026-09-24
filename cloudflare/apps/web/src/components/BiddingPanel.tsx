// Renders the available bids for the current game (a Pass button plus every ranked bid strictly
// above `game.bid`), calling `onBid(bid)` when one is picked. Every button is disabled whenever
// it isn't this player's turn (`game.currentPlayerId !== myPlayerId`). Replaces the bidding
// section of FortyTwo/Client/Pages/Match.razor + its Chip-based bid buttons.
//
// Deliberately simplified vs. the old app's `Match.razor.cs` `BiddingOptions` getter: this
// doesn't port the forced-bid-on-third-pass rule, the >84 (2 marks) cap gated on prior bids, or
// the doubles-count-gated "Plunge" bid - Task 20's brief only asks for "available bids above
// game.bid" + a Pass button (see the Task 20 report for the full rationale).
import type { JSX } from 'react';
import type { Game } from '@fortytwo/rules';
import { Bid, bidToPrettyString } from '@fortytwo/rules';

export interface BiddingPanelProps {
  game: Game;
  myPlayerId: string;
  onBid: (bid: Bid) => void;
  disabled?: boolean;
}

// Bid is a numeric TS enum, so `Object.values(Bid)` yields both the forward (name -> value) and
// reverse (value -> name) mappings in one array - filter down to the numeric values only, then
// drop Pass (its own dedicated button below) and Plunge (out of scope, see header comment), and
// sort ascending so higher bids render in ranked order.
const RANKED_BIDS = (Object.values(Bid).filter((value): value is number => typeof value === 'number') as Bid[])
  .filter((value) => value !== Bid.Pass && value !== Bid.Plunge)
  .sort((a, b) => a - b);

export function BiddingPanel({ game, myPlayerId, onBid, disabled = false }: BiddingPanelProps): JSX.Element {
  const isMyTurn = game.currentPlayerId === myPlayerId;
  const allDisabled = disabled || !isMyTurn;
  const availableBids = RANKED_BIDS.filter((bid) => game.bid == null || bid > game.bid);

  return (
    <section className="bidding-panel" aria-label="Bidding">
      <p>Select a bid:</p>
      <div className="bidding-options">
        <button
          type="button"
          className="custom-chip custom-chip-warning custom-chip-large"
          disabled={allDisabled}
          onClick={() => onBid(Bid.Pass)}
        >
          {bidToPrettyString(Bid.Pass)}
        </button>
        {availableBids.map((bid) => (
          <button
            key={bid}
            type="button"
            className="custom-chip custom-chip-info custom-chip-large"
            disabled={allDisabled}
            onClick={() => onBid(bid)}
          >
            {bidToPrettyString(bid)}
          </button>
        ))}
      </div>
    </section>
  );
}
