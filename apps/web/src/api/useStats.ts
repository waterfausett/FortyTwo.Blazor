// The player's own lifetime stats (GET /api/users/stats), for the Profile and the Live search
// lobby's card. `enabled: false` holds off the request, for a page that only sometimes shows them.
import { useQuery } from '@tanstack/react-query';
import { useGetToken } from '../auth/useGetToken';
import { apiClient } from './client';

export function useStats(options: { enabled?: boolean } = {}) {
  const client = apiClient(useGetToken());
  return useQuery({ queryKey: ['stats'], queryFn: () => client.getStats(), enabled: options.enabled ?? true });
}
