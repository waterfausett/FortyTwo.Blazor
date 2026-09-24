// Renders the available bids for the current game (a Pass button plus every ranked bid strictly
// above `game.bid`), calling `onBid(bid)` when one is picked. Every button is disabled whenever
// it isn't this player's turn (`game.currentPlayerId !== myPlayerId`). Replaces the bidding
// section of FortyTwo/Client/Pages/Match.razor + its Chip-based bid buttons.
//
// Deliberately simplified vs. the old app's `Match.razor.cs` `BiddingOptions` getter: this
// doesn't port the forced-bid-on-third-pass rule or the >84 (2 marks) cap gated on prior bids -
// Task 20's brief only asks for "available bids above game.bid" + a Pass button (see the Task 20
// report for the full rationale). Plunge WAS originally excluded here too (lumped in with Pass's
// exclusion), but that was wrong: the design spec's explicit goal is to preserve the game rules
// exactly, including Plunge, which the engine (matchEngine.ts/validation.ts) fully supports - the
// exclusion just made it unreachable through the UI. Plunge is included below like any other
// ranked bid; the server (assertValidBid/assertActiveBidder) remains the real authority over
// whether it's actually legal to pick.
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
// drop Pass (its own dedicated button below), and sort ascending so higher bids render in ranked
// order. Plunge IS included here (see header comment) - it ranks at 169, between FourMarks (168)
// and FiveMarks (210), so it renders as just another option whenever it's the next legal bid.
const RANKED_BIDS = (Object.values(Bid).filter((value): value is number => typeof value === 'number') as Bid[])
  .filter((value) => value !== Bid.Pass)
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
