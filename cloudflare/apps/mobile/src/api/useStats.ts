// The player's own lifetime stats (GET /api/users/stats) for the Profile. Fetched each time the
// Profile opens - unlike the profile itself, they change as games finish.
import { useQuery } from '@tanstack/react-query';
import { useApi } from './useApi';

export function useStats() {
  const api = useApi();
  return useQuery({ queryKey: ['stats'], queryFn: () => api.getStats() });
}
