// The People list and its search: friends then recent players, swapped for search results once
// two characters are typed (after a pause, so each keystroke isn't a request).
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Person } from '@fortytwo/client';
import { useApi } from '@/api/useApi';

export const SEARCH_MIN = 2;
const SEARCH_DELAY_MS = 300;

function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function usePeople(query: string) {
  const api = useApi();
  const q = useDebounced(query.trim(), SEARCH_DELAY_MS);
  const searching = q.length >= SEARCH_MIN;
  const queryClient = useQueryClient();
  const people = useQuery({ queryKey: ['people'], queryFn: () => api.getPeople() });
  const search = useQuery({ queryKey: ['people', 'search', q], queryFn: () => api.searchPeople(q), enabled: searching });
  const toggle = useMutation({
    mutationFn: (p: Person) => (p.isFriend ? api.removeFriend(p.user_id) : api.addFriend(p.user_id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['people'] }),
  });
  const shown = searching ? search : people;
  return {
    list: shown.data,
    loading: shown.isLoading,
    error: shown.error,
    searching,
    toggleFriend: (p: Person) => toggle.mutate(p),
    refresh: async () => {
      await queryClient.invalidateQueries({ queryKey: ['people'] });
    },
  };
}
