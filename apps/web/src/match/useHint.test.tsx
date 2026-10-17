import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bid, createDomino, createMatch, placeBid, takeSeat, type Domino, type MatchState } from '@fortytwo/rules';
import type { Hint, HintResponse } from '@fortytwo/api-types';
import { useHint } from './useHint';

afterEach(() => vi.useRealTimers());

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}
function practice(): MatchState {
  let m = createMatch('me', 'bots');
  m = takeSeat(m, 'm_bot-1', 1);
  m = takeSeat(m, 'm_bot-2', 2);
  m = takeSeat(m, 'm_bot-3', 3, deck());
  return { ...m, currentGame: { ...m.currentGame, firstActionBy: 'me', currentPlayerId: 'me' } };
}
const hint: Hint = { kind: 'bid', suggestion: { bid: 30, trump: 6, pMake: 0.7 }, options: [{ bid: 30, trump: 6, pMake: 0.7 }] };

describe('useHint', () => {
  it('asks on demand, shows loading, then the hint, and reuses it on the same turn', async () => {
    const getHint = vi.fn(async (): Promise<HintResponse> => ({ status: 'ready', hint }));
    const match = practice();
    const { result } = renderHook(() => useHint(match, 'me', true, getHint));

    expect(result.current.available).toBe(true);
    expect(result.current.state.status).toBe('idle');
    expect(getHint).not.toHaveBeenCalled();

    act(() => result.current.ask());
    expect(result.current.state.status).toBe('loading');
    await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', hint }));
    expect(result.current.hint).toEqual(hint);

    act(() => result.current.ask());
    expect(getHint).toHaveBeenCalledTimes(1);
  });

  it('drops the hint, and any answer still on its way, when the turn moves on', async () => {
    let answer!: (r: HintResponse) => void;
    const getHint = vi.fn(() => new Promise<HintResponse>((resolve) => (answer = resolve)));
    const first = practice();
    const { result, rerender } = renderHook(({ match }) => useHint(match, 'me', true, getHint), { initialProps: { match: first } });

    act(() => result.current.ask());
    rerender({ match: placeBid(first, 'me', Bid.Pass) });
    await act(async () => answer({ status: 'ready', hint }));

    expect(result.current.state.status).toBe('idle');
    expect(result.current.hint).toBeNull();
  });

  it('is unavailable while paused (a pre-play is queued), outside practice, or with bots off', () => {
    const getHint = vi.fn();
    expect(renderHook(() => useHint(practice(), 'me', true, getHint, true)).result.current.available).toBe(false);
    expect(renderHook(() => useHint({ ...practice(), mode: 'custom' }, 'me', true, getHint)).result.current.available).toBe(false);
    expect(renderHook(() => useHint(practice(), 'me', false, getHint)).result.current.available).toBe(false);
  });

  it('shows why a hint failed', async () => {
    const getHint = vi.fn(async (): Promise<HintResponse> => ({ status: 'unavailable' }));
    const match = practice();
    const { result } = renderHook(() => useHint(match, 'me', true, getHint));
    act(() => result.current.ask());
    await waitFor(() => expect(result.current.state).toEqual({ status: 'error', message: "Hints aren't available right now." }));
  });
});
