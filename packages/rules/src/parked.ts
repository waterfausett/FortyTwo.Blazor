import { gameWinningTeam } from './game';
import { replaceWithBot } from './live';
import type { MatchPlayerState, MatchState } from './matchEngine';

// A bot playing out the hand for a player who left a Custom match.
export function isParked(match: MatchState, playerId: string): boolean {
  return (match.parked ?? []).includes(playerId);
}

// The positions nobody holds: empty seats, and parked ones once the hand is decided. Until then a
// parked seat is still the bot's, finishing the hand.
export function openPositions(match: MatchState): number[] {
  const decided = gameWinningTeam(match.currentGame) !== null;
  const held = match.players.filter((p) => !(decided && isParked(match, p.playerId))).map((p) => p.position);
  return [0, 1, 2, 3].filter((position) => !held.includes(position));
}

// The players actually sitting at the table: everyone but a parked bot whose seat is open.
export function seatedPlayers(match: MatchState): MatchPlayerState[] {
  const open = openPositions(match);
  return match.players.filter((p) => !open.includes(p.position));
}

// A bot takes over a leaver's seat and hand, but unlike a replaced player the seat isn't theirs for
// good: it is marked parked and goes unready, so it opens for someone else once the hand is done.
export function parkSeat(match: MatchState, playerId: string): MatchState {
  const position = match.players.find((p) => p.playerId === playerId)?.position;
  const { replaced, ...rest } = replaceWithBot(match, playerId);
  const bot = rest.players.find((p) => p.position === position)!;
  return {
    ...rest,
    players: rest.players.map((p) => (p.playerId === bot.playerId ? { ...p, ready: false } : p)),
    parked: [...(match.parked ?? []), bot.playerId],
    // The leaver isn't a replaced player, so replaceWithBot's note of them is dropped.
    ...(match.replaced ? { replaced: match.replaced } : {}),
  };
}
