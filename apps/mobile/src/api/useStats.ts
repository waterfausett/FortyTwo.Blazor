// The player's own lifetime stats (GET /api/users/stats), for the Profile and the Live search
// lobby's card. Fetched each time one opens - unlike the profile itself, they change as games
// finish. `enabled: false` holds off the request, for a screen that only sometimes shows them.
import { useQuery } from '@tanstack/react-query';
import { useApi } from './useApi';

export function useStats(options: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({ queryKey: ['stats'], queryFn: () => api.getStats(), enabled: options.enabled ?? true });
}
