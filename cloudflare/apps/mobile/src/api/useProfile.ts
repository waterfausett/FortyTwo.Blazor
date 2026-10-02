// The player's own profile and settings (GET /api/users/profile), shared by every screen that
// reads them under one query key, plus saving a change to them.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProfilePatch, UserProfile } from '@fortytwo/api-types';
import { showError } from '@/components/showError';
import { useApi } from './useApi';

const PROFILE_KEY = ['profile'];

export function useProfile() {
  const api = useApi();
  return useQuery({ queryKey: PROFILE_KEY, queryFn: () => api.getProfile(), staleTime: Infinity });
}

// Applies the change on screen straight away, and puts it back if the save fails.
export function useSaveProfile() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: ProfilePatch) => api.patchProfile(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: PROFILE_KEY });
      const previous = queryClient.getQueryData<UserProfile>(PROFILE_KEY);
      if (previous) queryClient.setQueryData<UserProfile>(PROFILE_KEY, { ...previous, ...patch });
      return { previous };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(PROFILE_KEY, context.previous);
      showError(error);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: PROFILE_KEY }),
  });
}
