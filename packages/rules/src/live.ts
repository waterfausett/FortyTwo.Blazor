// Live play's clocks, and who a match is waiting on. Pure, like the rest of the rules: the
// Worker's MatchDO turns these deadlines into alarms, and the clients count down to the same ones.
import { isBot, mintBotId } from './botIds';
import { gameWinningTeam, type Game } from './game';
import { hasBeenDealt, matchScores, type MatchState } from './matchEngine';
import { ValidationError } from './errors';
import { assertIsMatchPlayer } from './validation';

export type MatchMode = 'live' | 'daily' | 'custom' | 'bots';

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
// the humans it's waiting on onto autopilot. Mid-hand the player to act is who usually changes
// the match, so `updatedOn` is when their turn began; a seated player readying up mid-hand also
// restarts the clock, which only gives the table a little extra time.
export interface LiveDeadline {
  kind: 'fill' | 'turn' | 'drop';
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
  const turnEnds = Date.parse(match.updatedOn) + LIVE_TURN_MS;
  // Nobody else is here to play with: rather than let bots play the table on its own, it waits,
  // and is dropped if they don't come back.
  const present = match.players.filter((p) => isPresent(match, p.playerId)).map((p) => p.playerId);
  if (present.every((id) => humans.includes(id))) return { kind: 'drop', at: turnEnds + LIVE_ABANDON_MS, playerIds: humans };
  return { kind: 'turn', at: turnEnds, playerIds: humans };
}

// The bot made this player's bid or trump call while they were on autopilot (bots.ts), so the
// hand doesn't count as theirs in stats.
export function markAutoBid(match: MatchState, playerId: string): MatchState {
  const hands = match.currentGame.hands.map((h) => (h.playerId === playerId ? { ...h, autoBid: true as const } : h));
  return { ...match, currentGame: { ...match.currentGame, hands } };
}

// How long a table whose last present player has run out their turn waits for them before it's
// dropped. Bots don't play on meanwhile - nobody would be watching.
export const LIVE_ABANDON_MS = 120_000;
// Newcomers can't claim a seat once either team has this many marks: they'd join for a hand or two.
export const TAKEOVER_MAX_MARKS = 5;

// At the table and playing: seated, a person, and not on autopilot.
export function isPresent(match: MatchState, playerId: string): boolean {
  return match.players.some((p) => p.playerId === playerId) && !isBot(playerId) && !isOnAutopilot(match, playerId);
}

export function setAutopilot(match: MatchState, playerIds: string[], on: boolean): MatchState {
  const ids = new Set(match.autopilot ?? []);
  const awaySince = { ...match.awaySince };
  const at = new Date().toISOString();
  for (const id of playerIds) {
    if (on) {
      if (!ids.has(id)) awaySince[id] = at;
      ids.add(id);
    } else {
      ids.delete(id);
      delete awaySince[id];
    }
  }
  return { ...match, autopilot: [...ids], awaySince };
}

// A player taking their seat back from the bot. Only a player on autopilot has anything to take
// back; anyone else resuming is a no-op, so nobody can restart someone else's clock. When the table
// is waiting on them, their clock starts over - or the deadline that put them on autopilot, already
// past, would put them straight back on it.
export function resumeControl(match: MatchState, playerId: string): MatchState {
  assertIsMatchPlayer(match, playerId);
  if (!isOnAutopilot(match, playerId)) return match;
  const cleared = setAutopilot(match, [playerId], false);
  if (!tableWait(match)?.playerIds.includes(playerId)) return cleared;
  return { ...cleared, updatedOn: new Date().toISOString() };
}

// A game with every id that names `fromId` renamed to `toId`: the hand, the bid, the turn and the
// tricks played. Hands already filed in `games` are not part of it and keep the old id.
export function renamePlayer(game: Game, fromId: string, toId: string): Game {
  const rename = (id: string | null) => (id === fromId ? toId : id);
  return {
    ...game,
    firstActionBy: rename(game.firstActionBy),
    biddingPlayerId: rename(game.biddingPlayerId),
    currentPlayerId: rename(game.currentPlayerId),
    hands: game.hands.map((h) => (h.playerId === fromId ? { ...h, playerId: toId } : h)),
    tricks: game.tricks.map((t) => ({ ...t, playerId: rename(t.playerId) })),
    currentTrick: { ...game.currentTrick, playerId: rename(game.currentTrick.playerId) },
  };
}

// A bot takes a player's seat for good: when they leave a Live Play game, or were away for
// a whole hand. Mid-hand the bot picks up their hand, bid and turn, so every id in the hand that
// names them is renamed. Hands already filed keep the player's id.
export function replaceWithBot(match: MatchState, playerId: string): MatchState {
  assertIsMatchPlayer(match, playerId);
  const botId = mintBotId(match.id, match.players.map((p) => p.playerId));
  if (botId === undefined) throw new ValidationError('No bot free to take the seat');

  const currentGame = renamePlayer(match.currentGame, playerId, botId);
  const off = setAutopilot(match, [playerId], false);
  return {
    ...off,
    autopilot: off.autopilot!.filter((id) => id !== playerId),
    players: match.players.map((p) => (p.playerId === playerId ? { ...p, playerId: botId } : p)),
    currentGame,
    replaced: [...(match.replaced ?? []), playerId],
    hadBots: true,
    updatedOn: new Date().toISOString(),
  };
}

// Why a paused table refuses a claim. The Matchmaker keeps such a table listed: it may come back.
export const TABLE_PAUSED = 'This game is waiting on its last player';

// Asks for the next bot seat that comes up at a hand break. Only in a Live Play game under
// way that isn't nearly over or paused, and never more claims than bot seats, so every claim is seated at
// the next break.
export function claimSeat(match: MatchState, playerId: string): MatchState {
  if (matchMode(match) !== 'live') throw new ValidationError('Only Live Play games take newcomers');
  if (!hasBeenDealt(match) || match.winningTeam !== null) throw new ValidationError('This game has no seat to take');
  if (Object.values(matchScores(match)).some((marks) => (marks ?? 0) >= TAKEOVER_MAX_MARKS)) {
    throw new ValidationError('This game is nearly over');
  }
  // A table paused on its last present player (their turn ran out) may soon be dropped; a newcomer
  // seated there would have nobody to play with. One still counting down their turn takes claims.
  const deadline = liveDeadline(match);
  if (deadline?.kind === 'drop' && Date.now() >= deadline.at - LIVE_ABANDON_MS) {
    throw new ValidationError(TABLE_PAUSED);
  }
  const claims = match.claims ?? [];
  if (match.players.some((p) => p.playerId === playerId) || claims.includes(playerId)) {
    throw new ValidationError("You're already at this table");
  }
  if (claims.length >= match.players.filter((p) => isBot(p.playerId)).length) {
    throw new ValidationError('No seat free at this table');
  }
  return { ...match, claims: [...claims, playerId] };
}

export function releaseClaim(match: MatchState, playerId: string): MatchState {
  if (!(match.claims ?? []).includes(playerId)) return match;
  return { ...match, claims: match.claims!.filter((id) => id !== playerId) };
}

// On autopilot since before this hand was dealt. A hand with no deal time (stored before it was
// kept) never counts, so nobody is replaced on the strength of a guess.
export function isAwayAllHand(match: MatchState, playerId: string): boolean {
  const since = match.awaySince?.[playerId];
  const dealtOn = match.currentGame.dealtOn;
  return isOnAutopilot(match, playerId) && since !== undefined && dealtOn !== undefined && since <= dealtOn;
}

// Who sits where for the next hand of a Live Play game: players away for the whole hand
// give their seats to bots, then claims take bot seats, lowest position first. Run as the hand
// break deals (patchPlayerReady). Anything else passes through untouched.
export function seatChangesAtBreak(match: MatchState): MatchState {
  if (matchMode(match) !== 'live') return match;
  let next = match;
  for (const p of match.players) {
    if (isAwayAllHand(next, p.playerId)) next = replaceWithBot(next, p.playerId);
  }
  const claims = [...(next.claims ?? [])];
  // Bot seats in position order, each handed the next claim in the order they were made.
  const taker = new Map<number, string>();
  for (const seat of next.players.filter((p) => isBot(p.playerId)).sort((a, b) => a.position - b.position)) {
    const claimant = claims.shift();
    if (claimant === undefined) break;
    taker.set(seat.position, claimant);
  }
  const players = next.players.map((p) => (taker.has(p.position) ? { ...p, playerId: taker.get(p.position)! } : p));
  return { ...next, players, claims };
}

// The match ended with claims still waiting: those players are let go, and their app searches again.
export function letClaimsGo(match: MatchState): MatchState {
  if ((match.claims ?? []).length === 0) return match;
  return { ...match, claims: [], bumped: [...(match.bumped ?? []), ...match.claims!] };
}
