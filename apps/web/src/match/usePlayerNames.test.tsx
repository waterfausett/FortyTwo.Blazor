import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PublicUser } from '@fortytwo/client';
import { usePlayerNames } from './usePlayerNames';

const seated = (...ids: string[]) => ids.map((playerId, position) => ({ playerId, position }));
const echo = (ids: string[]): PublicUser[] => ids.map((id) => ({ user_id: id, displayName: `name-${id}` }));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

describe('usePlayerNames', () => {
  it('excludes the viewer, who is always You', async () => {
    const search = vi.fn(async (ids: string[]) => echo(ids));
    const { wrapper } = setup();
    const { result } = renderHook(() => usePlayerNames(seated('p1', 'p2'), 'p1', search), { wrapper });
    expect(result.current.nameFor('p1')).toEqual({ status: 'loaded', name: 'You' });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(search).toHaveBeenCalledWith(['p2']);
  });

  it('looks up only a newcomer, keeping the names already shown', async () => {
    const search = vi.fn(async (ids: string[]) => echo(ids));
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ ids }) => usePlayerNames(seated(...ids), 'p1', search), {
      wrapper,
      initialProps: { ids: ['p1', 'p2'] },
    });
    await waitFor(() => expect(result.current.nameFor('p2')).toEqual({ status: 'loaded', name: 'name-p2' }));

    rerender({ ids: ['p1', 'p2', 'p3'] });
    expect(result.current.nameFor('p2')).toEqual({ status: 'loaded', name: 'name-p2' });
    expect(result.current.nameFor('p3')).toEqual({ status: 'loading' });
    expect(result.current.ready).toBe(false);

    await waitFor(() => expect(result.current.nameFor('p3')).toEqual({ status: 'loaded', name: 'name-p3' }));
    expect(search).toHaveBeenLastCalledWith(['p3']);
    expect(result.current.ready).toBe(true);
  });

  it('names everyone at once when they were all looked up before', async () => {
    const search = vi.fn(async (ids: string[]) => echo(ids));
    const { wrapper } = setup();
    const first = renderHook(() => usePlayerNames(seated('p1', 'p2', 'p3'), 'p1', search), { wrapper });
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    first.unmount();

    const { result } = renderHook(() => usePlayerNames(seated('p1', 'p3', 'p2'), 'p1', search), { wrapper });
    expect(result.current.ready).toBe(true);
    expect(result.current.nameFor('p3')).toEqual({ status: 'loaded', name: 'name-p3' });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('calls a player the lookup did not find by their seat', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => usePlayerNames(seated('p1', 'p2'), 'p1', async () => []), { wrapper });
    await waitFor(() => expect(result.current.nameFor('p2')).toEqual({ status: 'failed', name: 'Player 2' }));
    expect(result.current.ready).toBe(true);
  });

  it('keeps known names when a later lookup fails', async () => {
    const search = vi.fn(async (ids: string[]) => echo(ids));
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ ids }) => usePlayerNames(seated(...ids), 'p1', search), {
      wrapper,
      initialProps: { ids: ['p1', 'p2'] },
    });
    await waitFor(() => expect(result.current.ready).toBe(true));

    search.mockRejectedValueOnce(new Error('down'));
    rerender({ ids: ['p1', 'p2', 'p3'] });
    await waitFor(() => expect(result.current.nameFor('p3')).toEqual({ status: 'failed', name: 'Player 3' }));
    expect(result.current.nameFor('p2')).toEqual({ status: 'loaded', name: 'name-p2' });
  });
});
