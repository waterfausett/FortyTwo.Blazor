// Renders the bids this player may legally make right now (see `availableBids` in the rules
// package: Pass unless forced to bid, only bids above `game.bid`, marks one rung at a time, and
// Plunge only with four doubles), calling `onBid(bid)` when one is picked. Every button is
// disabled whenever it isn't this player's turn (`game.currentPlayerId !== myPlayerId`).
import type { JSX, ReactNode } from 'react';
import type { Game } from '@fortytwo/rules';
import { Bid, availableBids, bidToPrettyString } from '@fortytwo/rules';

export interface BiddingPanelProps {
  game: Game;
  myPlayerId: string;
  onBid: (bid: Bid) => void;
  disabled?: boolean;
  // The bid a hint suggests, outlined.
  suggested?: Bid | null;
  // Shown beside the prompt: the Hint button, or its answer.
  hint?: ReactNode;
}

export function BiddingPanel({ game, myPlayerId, onBid, disabled = false, suggested = null, hint = null }: BiddingPanelProps): JSX.Element {
  const isMyTurn = game.currentPlayerId === myPlayerId;
  const allDisabled = disabled || !isMyTurn;
  const bids = availableBids(game, myPlayerId);

  return (
    <section className="bidding-panel" aria-label="Bidding">
      <div className="action-prompt-row">
        <p className="action-prompt">Select a bid</p>
        {hint}
      </div>
      <div className="bidding-options">
        {bids.map((bid) => (
          <button
            key={bid}
            type="button"
            className={`${bid === Bid.Pass ? 'bid-tile bid-tile-pass' : 'bid-tile'}${bid === suggested ? ' bid-tile-suggested' : ''}`}
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
