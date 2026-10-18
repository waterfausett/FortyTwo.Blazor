// The lobby's row for a match the player has just left, brought up to date from the match as the
// match screen last saw it (rowFromMatch) - so a turn just taken there doesn't still read "Your
// turn" back in the lobby, with no fetch. A row it can't update alone (someone has sat down since it
// loaded), or a match that has just finished and belongs in History now, has the lists fetched again.
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { rowFromMatch, type MatchPage } from '@fortytwo/client';
import type { MatchState } from '@fortytwo/rules';

// `matchId` is the screen's own, the row the player opened.
export function updateLobbyRow(queryClient: QueryClient, matchId: string, match: MatchState, viewerId: string) {
  let refetch = false;
  queryClient.setQueryData<InfiniteData<MatchPage, string | undefined>>(['matches', 'Active'], (data) =>
    data && {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        matches: page.matches.map((row) => {
          if (row.id !== matchId) return row;
          const updated = rowFromMatch(row, match, viewerId);
          if (updated === null || updated.status === 'completed') refetch = true;
          return updated ?? row;
        }),
      })),
    }
  );
  if (refetch) void queryClient.invalidateQueries({ queryKey: ['matches'] });
}
