import { nextPosition, Positions } from './positions';
import { Suit, isLow } from './suit';

export interface MatchPlayerRef {
  playerId: string;
  position: Positions;
}

// The id of whoever plays after `currentPlayerId`, going round the table. On a Low trump the
// bidder's partner sits out, so they're skipped.
export function selectNextPlayer(
  currentPlayerId: string,
  biddingPlayerId: string | null,
  trump: Suit | null,
  players: MatchPlayerRef[]
): string {
  if (!currentPlayerId || currentPlayerId.trim() === '') return currentPlayerId;

  let nextPlayerPosition = nextPosition(players.find((x) => x.playerId === currentPlayerId)!.position);

  if (isLow(trump)) {
    const biddingPlayerPosition = players.find((x) => x.playerId === biddingPlayerId)!.position;

    if (biddingPlayerPosition !== nextPlayerPosition && biddingPlayerPosition % 2 === nextPlayerPosition % 2) {
      nextPlayerPosition = nextPosition(nextPlayerPosition);
    }
  }

  return players.find((x) => x.position === nextPlayerPosition)!.playerId;
}
