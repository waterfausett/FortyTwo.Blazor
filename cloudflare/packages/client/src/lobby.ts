// Helpers for the lobby's paged match lists (GET /api/matches returns one MatchPage at a time).
import type { MatchMode, MatchPage, MatchSummary } from '@fortytwo/api-types';

// Every loaded page's rows in order, each match once: a match updated between page loads moves
// to the top, so it can come back on a later page too.
export function uniqueMatches(pages: MatchPage[] | undefined): MatchSummary[] | undefined {
  if (pages === undefined) return undefined;
  const seen = new Set<string>();
  return pages
    .flatMap((p) => p.matches)
    .filter((match) => {
      if (seen.has(match.id)) return false;
      seen.add(match.id);
      return true;
    });
}

export const MODE_LABELS: Record<MatchMode, string> = { live: 'Live', daily: 'Daily', custom: 'Custom' };

// What a lobby row says the match is waiting on, and whether that's the viewer.
export function rowStatus(match: MatchSummary): { text: string; yours: boolean } {
  if (match.status === 'completed') return { text: 'Finished', yours: false };
  if (match.playerCount < 4) return { text: `Looking for players · ${match.playerCount} of 4`, yours: false };
  const turn = match.turn;
  if (turn == null) return { text: 'In play', yours: false };
  if (turn.yours) return { text: turn.kind === 'ready' ? 'Ready up' : 'Your turn', yours: true };
  if (turn.kind === 'ready') return { text: 'Waiting for others to ready up', yours: false };
  return { text: `${turn.waitingOn[0] ?? 'Someone'}'s turn`, yours: false };
}

// Games waiting on the viewer first, the rest in the order they came. Only sorts rows already
// loaded: pages still arrive newest first.
export function yourTurnFirst(rows: MatchSummary[]): MatchSummary[] {
  return [...rows.filter((m) => m.turn?.yours), ...rows.filter((m) => !m.turn?.yours)];
}
