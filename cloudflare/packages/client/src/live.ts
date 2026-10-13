// What the match page shows of Live and Daily play: how long a search has run, and the clock on
// a Live turn - from the same deadlines the Worker acts on (@fortytwo/rules' live.ts).
import { LIVE_ABANDON_MS, hasBeenDealt, liveDeadline, matchMode, tableWait, type MatchState } from '@fortytwo/rules';

// A table still looking for players: a Live search counting up, or a Daily table waiting.
export function searchState(match: MatchState, now: number): { mode: 'live'; elapsedMs: number } | { mode: 'daily' } | null {
  if (match.players.length >= 4 || hasBeenDealt(match)) return null;
  const mode = matchMode(match);
  if (mode === 'daily') return { mode: 'daily' };
  if (mode === 'live' && match.searchStartedOn !== undefined) {
    return { mode: 'live', elapsedMs: Math.max(0, now - Date.parse(match.searchStartedOn)) };
  }
  return null;
}

// How the viewer stands at this table, which decides what the match page shows them.
export type ViewerRole = 'seated' | 'claiming' | 'bumped' | 'replaced' | 'stranger';

export function viewerRole(match: MatchState, viewerId: string): ViewerRole {
  if (match.players.some((p) => p.playerId === viewerId)) return 'seated';
  if (match.claims?.includes(viewerId)) return 'claiming';
  if (match.bumped?.includes(viewerId)) return 'bumped';
  if (match.replaced?.includes(viewerId)) return 'replaced';
  return 'stranger';
}

// Someone watching without a seat sees the table from the first seat's side.
export function watchAnchor(match: MatchState): string | null {
  return [...match.players].sort((a, b) => a.position - b.position)[0]?.playerId ?? null;
}

// Seats whose player changed between two versions of a match: for "Sam took Bot 2's seat".
export function seatChanges(previous: MatchState, next: MatchState): { position: number; from: string; to: string }[] {
  return next.players.flatMap((p) => {
    const before = previous.players.find((q) => q.position === p.position);
    return before && before.playerId !== p.playerId ? [{ position: p.position, from: before.playerId, to: p.playerId }] : [];
  });
}

// Time left on a Live turn before a bot plays it, and whose it is. A paused table - the last
// player there ran out their turn - shows them overdue until they act or it's dropped. None at the
// hand break, where nobody is taking a turn: nextHandClock covers that wait.
export function turnClock(match: MatchState, now: number): { playerIds: string[]; remainingMs: number; paused: boolean } | null {
  if (tableWait(match)?.kind !== 'turn') return null;
  const deadline = liveDeadline(match);
  if (deadline === null || deadline.kind === 'fill') return null;
  if (deadline.kind === 'drop') {
    const turnEnds = deadline.at - LIVE_ABANDON_MS;
    return { playerIds: deadline.playerIds, remainingMs: Math.max(0, turnEnds - now), paused: now >= turnEnds };
  }
  return { playerIds: deadline.playerIds, remainingMs: Math.max(0, deadline.at - now), paused: false };
}

// Time left at a Live hand break before bots ready up whoever hasn't, which deals the next hand.
// Only once someone has readied: until then, running out pauses the table (a 'drop' deadline)
// rather than dealing.
export function nextHandClock(match: MatchState, now: number): number | null {
  if (tableWait(match)?.kind !== 'ready') return null;
  const deadline = liveDeadline(match);
  return deadline?.kind === 'turn' ? Math.max(0, deadline.at - now) : null;
}

export function formatClock(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
