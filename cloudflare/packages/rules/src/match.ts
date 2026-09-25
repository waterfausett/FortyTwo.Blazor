import { nextPosition, Positions } from './positions';
import { Suit } from './suit';

export interface MatchPlayerRef {
  playerId: string;
  position: Positions;
}

// Pure-function port of C# `MatchExtensions.SelectNextPlayer`
// (FortyTwo.Entity/Models/Match.cs). Returns the next player's id instead of mutating
// a Match in place.
export function selectNextPlayer(
  currentPlayerId: string,
  biddingPlayerId: string | null,
  trump: Suit | null,
  players: MatchPlayerRef[]
): string {
  // C#: `if (string.IsNullOrWhiteSpace(match.CurrentGame?.CurrentPlayerId)) return;` — a no-op.
  if (!currentPlayerId || currentPlayerId.trim() === '') return currentPlayerId;

  let nextPlayerPosition = nextPosition(players.find((x) => x.playerId === currentPlayerId)!.position);

  if (trump === Suit.Low) {
    const biddingPlayerPosition = players.find((x) => x.playerId === biddingPlayerId)!.position;

    if (biddingPlayerPosition !== nextPlayerPosition && biddingPlayerPosition % 2 === nextPlayerPosition % 2) {
      nextPlayerPosition = nextPosition(nextPlayerPosition);
    }
  }

  return players.find((x) => x.position === nextPlayerPosition)!.playerId;
}
