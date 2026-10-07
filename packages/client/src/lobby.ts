// Helpers for the lobby's paged match lists (GET /api/matches returns one MatchPage at a time).
import type { MatchPage, MatchSummary } from '@fortytwo/api-types';

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
