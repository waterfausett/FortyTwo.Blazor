import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PublicUser } from '@fortytwo/client';
import { usePlayerNames } from '../usePlayerNames';

const seated = (...ids: string[]) => ids.map((playerId, position) => ({ playerId, position }));
const echo = (ids: string[]): PublicUser[] => ids.map((id) => ({ user_id: id, displayName: `name-${id}` }));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { wrapper };
}

describe('usePlayerNames', () => {
  it('looks up only a newcomer, keeping the names already shown', async () => {
    // The newcomer's lookup is held open, so `ready` is false for as long as the assertion needs.
    let releaseNewcomer = () => {};
    const search = jest.fn(async (ids: string[]) => {
      if (ids.includes('p3')) await new Promise<void>((resolve) => { releaseNewcomer = resolve; });
      return echo(ids);
    });
    const { wrapper } = setup();
    const { result, rerender } = await renderHook(
      ({ ids }: { ids: string[] }) => usePlayerNames(seated(...ids), 'p1', search),
      { wrapper, initialProps: { ids: ['p1', 'p2'] } }
    );
    await waitFor(() => expect(result.current.nameFor('p2')).toEqual({ status: 'loaded', name: 'name-p2' }));
    expect(search).toHaveBeenCalledWith(['p2']);

    await rerender({ ids: ['p1', 'p2', 'p3'] });
    expect(result.current.nameFor('p2')).toEqual({ status: 'loaded', name: 'name-p2' });
    expect(result.current.ready).toBe(false);

    releaseNewcomer();
    await waitFor(() => expect(result.current.nameFor('p3')).toEqual({ status: 'loaded', name: 'name-p3' }));
    expect(search).toHaveBeenLastCalledWith(['p3']);
  });

  it('calls a player the lookup did not find by their seat', async () => {
    const { wrapper } = setup();
    const { result } = await renderHook(() => usePlayerNames(seated('p1', 'p2'), 'p1', async () => []), { wrapper });
    await waitFor(() => expect(result.current.nameFor('p2')).toEqual({ status: 'failed', name: 'Player 2' }));
  });
});
