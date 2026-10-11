// What the match page shows of Live and Daily play: how long a search has run, and the clock on
// a Live turn - from the same deadlines the Worker acts on (@fortytwo/rules' live.ts).
import { hasBeenDealt, liveDeadline, matchMode, type MatchState } from '@fortytwo/rules';

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

// Time left on a Live turn before a bot plays it, and whose it is.
export function turnClock(match: MatchState, now: number): { playerIds: string[]; remainingMs: number } | null {
  const deadline = liveDeadline(match);
  if (deadline === null || deadline.kind !== 'turn') return null;
  return { playerIds: deadline.playerIds, remainingMs: Math.max(0, deadline.at - now) };
}

export function formatClock(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
