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

export const MODE_LABELS: Record<MatchMode, string> = { live: 'Live Play', daily: 'Async', custom: 'Custom', bots: 'vs Bots' };

// "Alice & Cara vs Bob & bot-3". A team nobody has joined yet reads as `empty` ("?" by default); a
// row with no players at all falls back to the match id so it still has a label.
export function formatMatchup({ id, teams }: MatchSummary, empty = '?'): string {
  if (teams.every((team) => team.length === 0)) return id;
  return teams.map((team) => (team.length > 0 ? team.join(' & ') : empty)).join(' vs ');
}

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

// The caller's tables a person could be invited to from the People tab: active Custom tables with
// a seat open that the person isn't already at. Lobby rows carry names, not ids, so "at" goes by
// name; the Worker turns away an invite to someone seated anyway (people/invites.ts).
export function invitableTables(rows: MatchSummary[], personName: string): MatchSummary[] {
  return rows.filter(
    (m) => m.status === 'active' && m.mode === 'custom' && m.playerCount < 4 && !m.seats.includes(personName)
  );
}

// "You & Ann vs Open seats", over "2 seats open", for a table in the Invite to a table list.
export function tableTitle(match: MatchSummary): string {
  return formatMatchup(match, 'Open seats');
}

export function tableDetail(match: MatchSummary): string {
  const open = 4 - match.playerCount;
  return open === 1 ? '1 seat open' : `${open} seats open`;
}
