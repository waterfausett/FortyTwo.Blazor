// Table-geometry helpers for the match screen: where each player sits relative to "me", who dealt,
// who led a given trick, and which seat played each slot of a trick. None of this is stored on
// MatchState - it's all derived from the same rules the engine uses (matchEngine.ts/match.ts), so
// the client can show dealer/leader markers and seat-anchored trick tiles without a wire change.
import type { Game, MatchPlayerState, Trick } from '@fortytwo/rules';
import { Bid, nextPosition, selectNextPlayer } from '@fortytwo/rules';

// Where a player sits on screen, relative to the viewer. Play runs clockwise, so the next player
// after me sits to my left, my partner sits across, and the player before me sits to my right.
export type Seat = 'bottom' | 'left' | 'top' | 'right';

const SEATS_CLOCKWISE: Seat[] = ['bottom', 'left', 'top', 'right'];

export function seatFor(players: MatchPlayerState[], myPlayerId: string, playerId: string): Seat | null {
  const me = players.find((p) => p.playerId === myPlayerId);
  const them = players.find((p) => p.playerId === playerId);
  if (!me || !them) return null;
  return SEATS_CLOCKWISE[(them.position - me.position + 4) % 4];
}

// The dealer sits immediately before whoever acts first (the player to the dealer's left opens
// the bidding) - the inverse of patchPlayerReady's `nextPosition(lastGame.firstActionBy)` rotation.
export function dealerId(players: MatchPlayerState[], game: Game): string | null {
  const first = players.find((p) => p.playerId === game.firstActionBy);
  if (!first || players.length < 4) return null;
  const dealerPosition = (first.position + 3) % 4;
  return players.find((p) => p.position === dealerPosition)?.playerId ?? null;
}

// Who leads trick number `trickIndex` (0-based) of this hand. The first trick is led by whoever
// named trump - the high bidder, or on a Plunge the bidder's partner (placeBid hands the turn to
// them); every later trick is led by the previous trick's winner (playDomino's
// `currentPlayerId = currentTrick.playerId`).
export function trickLeaderId(players: MatchPlayerState[], game: Game, trickIndex: number): string | null {
  if (trickIndex > 0) return game.tricks[trickIndex - 1]?.playerId ?? null;
  if (game.biddingPlayerId == null) return null;
  if (game.bid !== Bid.Plunge) return game.biddingPlayerId;
  const bidder = players.find((p) => p.playerId === game.biddingPlayerId);
  if (!bidder) return null;
  const partnerPosition = nextPosition(nextPosition(bidder.position));
  return players.find((p) => p.position === partnerPosition)?.playerId ?? null;
}

// The player who played each slot of a trick, in slot order, starting from its leader and
// following the engine's own turn order (selectNextPlayer - which skips the bidder's partner when
// Low is trump).
export function trickPlayOrder(players: MatchPlayerState[], game: Game, leaderId: string | null): (string | null)[] {
  if (leaderId == null || players.length < 4) return [null, null, null, null];
  const order: string[] = [leaderId];
  while (order.length < 4) {
    order.push(selectNextPlayer(order[order.length - 1], game.biddingPlayerId, game.trump, players));
  }
  return order;
}

// Convenience for the display: the leader + per-slot seats of a trick.
export function trickSeats(
  players: MatchPlayerState[],
  myPlayerId: string,
  game: Game,
  trickIndex: number
): { leaderId: string | null; slotSeats: (Seat | null)[] } {
  const leaderId = trickLeaderId(players, game, trickIndex);
  const slotSeats = trickPlayOrder(players, game, leaderId).map((id) =>
    id == null ? null : seatFor(players, myPlayerId, id)
  );
  return { leaderId, slotSeats };
}

export function isTrickStarted(trick: Trick): boolean {
  return trick.dominoes.some((d) => d !== null);
}
