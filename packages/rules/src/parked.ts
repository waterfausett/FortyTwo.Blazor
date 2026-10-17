import { gameWinningTeam } from './game';
import { renamePlayer, replaceWithBot } from './live';
import { patchPlayerReady, type MatchPlayerState, type MatchState } from './matchEngine';
import type { Domino } from './domino';

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

// A person takes an open parked seat: the bot's id becomes theirs everywhere, so the hand they sit
// down to is the bot's, and they join ready. Readying runs the usual deal check, so if the other
// three were waiting the next hand starts now.
export function takeParkedSeat(match: MatchState, playerId: string, position: number, dealOrder: Domino[]): MatchState {
  const botId = match.players.find((p) => p.position === position)!.playerId;
  const swapped: MatchState = {
    ...match,
    players: match.players.map((p) => (p.playerId === botId ? { ...p, playerId, ready: true } : p)),
    currentGame: renamePlayer(match.currentGame, botId, playerId),
    parked: (match.parked ?? []).filter((id) => id !== botId),
  };
  return patchPlayerReady(swapped, playerId, true, dealOrder);
}

// Gives the parked bots at `positions` (every open parked seat when omitted) the seat for good, so
// the others can ready up without waiting for a person to fill it.
export function unpark(match: MatchState, positions: number[] = openPositions(match)): MatchState {
  const gone = match.players.filter((p) => positions.includes(p.position)).map((p) => p.playerId);
  return { ...match, parked: (match.parked ?? []).filter((id) => !gone.includes(id)) };
}
