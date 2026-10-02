// The player's own profile and settings (GET /api/users/profile), shared by every screen that
// reads them under one query key, plus saving a change to them.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProfilePatch, UserProfile } from '@fortytwo/api-types';
import { toastError } from '@/components/toast';
import { useApi } from './useApi';

const PROFILE_KEY = ['profile'];

export function useProfile() {
  const api = useApi();
  return useQuery({ queryKey: PROFILE_KEY, queryFn: () => api.getProfile(), staleTime: Infinity });
}

// Shows a new name or setting straight away, and puts it back if the save fails. A picture waits
// for the server, which works out what to show when the custom one is cleared.
export function useSaveProfile() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: ProfilePatch) => api.patchProfile(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: PROFILE_KEY });
      const previous = queryClient.getQueryData<UserProfile>(PROFILE_KEY);
      if (previous) {
        const { picture: _picture, ...shown } = patch;
        queryClient.setQueryData<UserProfile>(PROFILE_KEY, { ...previous, ...shown });
      }
      return { previous };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(PROFILE_KEY, context.previous);
      toastError(error);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: PROFILE_KEY }),
  });
}
