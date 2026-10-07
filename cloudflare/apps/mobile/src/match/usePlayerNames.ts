// Display names for the players at a match (@fortytwo/client's playerNames.ts says what to call
// each one). Names are cached per player across lookups: a join only looks up the newcomer, the
// names already shown stay up meanwhile, and a match whose players were all looked up before is
// named on its first render. The viewer is never looked up - they're always "You".
// The web app's match/usePlayerNames.ts is the same.
import { useMemo } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { mergeNames, missingIds, playerName, type PlayerName, type PublicUser } from '@fortytwo/client';

export const PLAYER_NAMES_KEY = 'playerNames';

export function usePlayerNames(
  players: readonly { playerId: string; position: number }[],
  myPlayerId: string | undefined,
  searchUsers: (ids: string[]) => Promise<PublicUser[]>
): { nameFor: (playerId: string) => PlayerName; ready: boolean } {
  const queryClient = useQueryClient();
  const ids = players.map((p) => p.playerId).filter((id) => id !== myPlayerId).sort();
  // Every name any earlier lookup found.
  const known = () =>
    mergeNames(...queryClient.getQueriesData<Map<string, string>>({ queryKey: [PLAYER_NAMES_KEY] }).map(([, data]) => data));

  const query = useQuery({
    queryKey: [PLAYER_NAMES_KEY, ids],
    queryFn: async () => {
      const names = known();
      const missing = missingIds(ids, names);
      if (missing.length > 0) for (const user of await searchUsers(missing)) names.set(user.user_id, user.displayName);
      return names;
    },
    initialData: () => {
      const names = known();
      return missingIds(ids, names).length === 0 ? names : undefined;
    },
    placeholderData: keepPreviousData,
    enabled: ids.length > 0,
    staleTime: Infinity,
  });

  // A failed lookup has no data of its own; the names found before it still stand.
  const names = query.data ?? known();
  const settled = query.isSuccess && !query.isPlaceholderData;
  const failed = query.isError;
  const seatsKey = players.map((p) => `${p.playerId}@${p.position}`).join();
  return useMemo(() => {
    const nameFor = (playerId: string) => playerName(playerId, { myPlayerId, players, names, settled, failed });
    return { nameFor, ready: ids.every((id) => nameFor(id).status !== 'loading') };
    // `players` and `ids` change identity every render; seatsKey stands for both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatsKey, myPlayerId, query.data, settled, failed]);
}
