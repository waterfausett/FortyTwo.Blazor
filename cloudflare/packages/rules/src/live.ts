// Live play's clocks, and who a match is waiting on. Pure, like the rest of the rules: the
// Worker's MatchDO turns these deadlines into alarms, and the clients count down to the same ones.
import { isBot } from './botIds';
import { gameWinningTeam } from './game';
import { hasBeenDealt, type MatchState } from './matchEngine';
import { assertIsMatchPlayer } from './validation';

export type MatchMode = 'live' | 'daily' | 'custom';

// How long a Live table looks for people before bots take its empty seats on their own - the
// fallback for a table nobody is watching. Players usually press Start now with bots sooner.
export const LIVE_FILL_MS = 150_000;
// How long a Live turn waits on a human before a bot plays it for them.
export const LIVE_TURN_MS = 60_000;

// Takes Partial so a stored match with no `mode` field still type-checks (a weak Pick<> would reject it).
export function matchMode(match: Partial<MatchState>): MatchMode {
  return match.mode ?? 'custom';
}

export function isOnAutopilot(match: MatchState, playerId: string): boolean {
  return match.autopilot?.includes(playerId) ?? false;
}

// Whether a bot makes this seat's moves: a bot's own, or a player's while they're on autopilot.
export function isBotControlled(match: MatchState, playerId: string): boolean {
  return isBot(playerId) || isOnAutopilot(match, playerId);
}

// Who the table is waiting on: the player to act, or - once the hand is decided - everyone still
// to ready up. Null before the deal and after the match is won.
export interface TableWait {
  kind: 'turn' | 'ready';
  playerIds: string[];
}

export function tableWait(match: MatchState): TableWait | null {
  if (match.winningTeam !== null || match.players.length < 4 || !hasBeenDealt(match)) return null;
  if (gameWinningTeam(match.currentGame) !== null) {
    return { kind: 'ready', playerIds: match.players.filter((p) => !p.ready).map((p) => p.playerId) };
  }
  const current = match.currentGame.currentPlayerId;
  return current === null ? null : { kind: 'turn', playerIds: [current] };
}

// The next thing a Live match does on its own, and when: fill its empty seats with bots, or put
// the humans it's waiting on onto autopilot. Mid-hand only the player to act can change the
// match, so `updatedOn` is when their turn began.
export interface LiveDeadline {
  kind: 'fill' | 'turn';
  at: number;
  playerIds: string[];
}

export function liveDeadline(match: MatchState): LiveDeadline | null {
  if (matchMode(match) !== 'live' || match.winningTeam !== null) return null;
  if (match.players.length < 4) {
    return match.searchStartedOn === undefined
      ? null
      : { kind: 'fill', at: Date.parse(match.searchStartedOn) + LIVE_FILL_MS, playerIds: [] };
  }
  const humans = tableWait(match)?.playerIds.filter((id) => !isBotControlled(match, id)) ?? [];
  if (humans.length === 0) return null;
  return { kind: 'turn', at: Date.parse(match.updatedOn) + LIVE_TURN_MS, playerIds: humans };
}

export function setAutopilot(match: MatchState, playerIds: string[], on: boolean): MatchState {
  const ids = new Set(match.autopilot ?? []);
  for (const id of playerIds) {
    if (on) ids.add(id);
    else ids.delete(id);
  }
  return { ...match, autopilot: [...ids] };
}

// A player taking their seat back from the bot. Their clock starts over, or the deadline that put
// them on autopilot - already past - would put them straight back on it.
export function resumeControl(match: MatchState, playerId: string): MatchState {
  assertIsMatchPlayer(match, playerId);
  return { ...setAutopilot(match, [playerId], false), updatedOn: new Date().toISOString() };
}
