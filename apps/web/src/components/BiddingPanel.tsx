// Renders the bids this player may legally make right now (see `availableBids` in the rules
// package: Pass unless forced to bid, only bids above `game.bid`, marks one rung at a time, and
// Plunge only with four doubles), calling `onBid(bid)` when one is picked. Every button is
// disabled whenever it isn't this player's turn (`game.currentPlayerId !== myPlayerId`).
import type { JSX } from 'react';
import type { Game } from '@fortytwo/rules';
import { Bid, availableBids, bidToPrettyString } from '@fortytwo/rules';

export interface BiddingPanelProps {
  game: Game;
  myPlayerId: string;
  onBid: (bid: Bid) => void;
  disabled?: boolean;
}

export function BiddingPanel({ game, myPlayerId, onBid, disabled = false }: BiddingPanelProps): JSX.Element {
  const isMyTurn = game.currentPlayerId === myPlayerId;
  const allDisabled = disabled || !isMyTurn;
  const bids = availableBids(game, myPlayerId);

  return (
    <section className="bidding-panel" aria-label="Bidding">
      <p className="action-prompt">Select a bid</p>
      <div className="bidding-options">
        {bids.map((bid) => (
          <button
            key={bid}
            type="button"
            className={bid === Bid.Pass ? 'bid-tile bid-tile-pass' : 'bid-tile'}
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
