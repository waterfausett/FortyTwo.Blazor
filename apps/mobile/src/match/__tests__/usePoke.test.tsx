import { act, renderHook } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createDomino, createMatch, takeSeat, type Domino, type MatchState } from '@fortytwo/rules';
import { POKE_IDLE_MS } from '@fortytwo/client';
import { toastInfo } from '@/components/toast';
import { usePoke } from '../usePoke';

jest.mock('@/components/toast', () => ({ toastInfo: jest.fn(), toastError: jest.fn() }));

function dealt(): MatchState {
  const deck: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) deck.push(createDomino(i, j));
  let match = createMatch('p1');
  match = takeSeat(match, 'p2', 1);
  match = takeSeat(match, 'p3', 2);
  return takeSeat(match, 'p4', 3, deck);
}

function wrapper({ children }: { children: ReactNode }) {
  // No garbage-collection timers left behind once the test ends.
  const client = new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('usePoke', () => {
  afterEach(() => jest.useRealTimers());

  it('offers a poke once the turn has waited, and hides it once the poke gets through', async () => {
    jest.useFakeTimers();
    const fresh = dealt();
    const turn = fresh.currentGame.currentPlayerId!;
    const me = ['p1', 'p2', 'p3', 'p4'].find((id) => id !== turn)!;
    const match = { ...fresh, updatedOn: new Date(Date.now() - POKE_IDLE_MS + 1000).toISOString() };
    const poke = jest.fn().mockResolvedValue({ delivered: 'inApp' });

    const { result } = await renderHook(() => usePoke(match, me, poke, (id) => `name-${id}`), { wrapper });
    expect(result.current.target).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(result.current.target).toBe(turn);

    await act(async () => {
      result.current.poke();
    });
    expect(poke).toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledWith(`Poked name-${turn}`);
    expect(result.current.target).toBeNull();
  });

  it("holds the poke back until the target's name has loaded", async () => {
    jest.useFakeTimers();
    const fresh = dealt();
    const turn = fresh.currentGame.currentPlayerId!;
    const me = ['p1', 'p2', 'p3', 'p4'].find((id) => id !== turn)!;
    const match = { ...fresh, updatedOn: new Date(Date.now() - POKE_IDLE_MS - 1000).toISOString() };
    let named = false;

    const { result, rerender } = await renderHook(() => usePoke(match, me, jest.fn(), () => (named ? 'Bob' : null)), {
      wrapper,
    });
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    expect(result.current.target).toBeNull();

    named = true;
    await rerender({});
    expect(result.current.target).toBe(turn);
  });
});
