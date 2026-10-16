// Whether to offer the Lobby's "New to 42?" card, and marking the rules seen (dismissing the card,
// or opening the rules page or dialog). Reads and updates the ['profile'] query shared with the
// profile and match pages: the card goes at once, and comes back if the save fails.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { shouldOfferHowToPlay } from '@fortytwo/client';
import type { apiClient, UserProfile } from '../api/client';

export function useHowToPlay(client: ReturnType<typeof apiClient>): { offer: boolean; markSeen: () => void } {
  const queryClient = useQueryClient();
  const profileQuery = useQuery({ queryKey: ['profile'], queryFn: () => client.getProfile(), staleTime: Infinity });
  const offer = shouldOfferHowToPlay(profileQuery.data);
  const save = useMutation({
    mutationFn: () => client.patchProfile({ seenHowToPlay: true }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['profile'] });
      const previous = queryClient.getQueryData<UserProfile>(['profile']);
      if (previous) queryClient.setQueryData<UserProfile>(['profile'], { ...previous, seenHowToPlay: true });
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(['profile'], context.previous);
    },
  });

  // Only a profile that says "not seen" is worth a save: one that's loading, already seen, or from
  // a worker that doesn't know the setting is left alone.
  function markSeen(): void {
    if (offer && !save.isPending) save.mutate();
  }

  return { offer, markSeen };
}
