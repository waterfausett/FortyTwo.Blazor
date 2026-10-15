// The People list and its search for one client: friends then recent players, swapped for search
// results once two characters are typed (after a pause, so each keystroke isn't a request).
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { apiClient, Person } from '../api/client';
import { toastError } from '../ui/toast';

export type PeopleClient = Pick<ReturnType<typeof apiClient>, 'getPeople' | 'searchPeople' | 'addFriend' | 'removeFriend'>;

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

export function usePeople(client: PeopleClient, query: string) {
  const q = useDebounced(query.trim(), SEARCH_DELAY_MS);
  const searching = q.length >= SEARCH_MIN;
  const queryClient = useQueryClient();
  const people = useQuery({ queryKey: ['people'], queryFn: () => client.getPeople() });
  const search = useQuery({ queryKey: ['people', 'search', q], queryFn: () => client.searchPeople(q), enabled: searching });
  const toggle = useMutation({
    mutationFn: (p: Person) => (p.isFriend ? client.removeFriend(p.user_id) : client.addFriend(p.user_id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['people'] }),
    onError: toastError,
  });
  const shown = searching ? search : people;
  return {
    list: shown.data,
    loading: shown.isLoading,
    error: shown.error,
    searching,
    toggleFriend: (p: Person) => toggle.mutate(p),
  };
}
