import { act, renderHook, waitFor } from '@testing-library/react-native';
import { Bid, createDomino, createMatch, placeBid, takeSeat, type Domino, type MatchState } from '@fortytwo/rules';
import type { Hint, HintResponse } from '@fortytwo/api-types';
import { useHint } from '../useHint';

afterEach(() => jest.useRealTimers());

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
    // Held until the test answers, so the loading state can be seen: async act would otherwise
    // flush an already-settled answer straight through it.
    let answer!: (r: HintResponse) => void;
    const getHint = jest.fn(() => new Promise<HintResponse>((resolve) => (answer = resolve)));
    const match = practice();
    const { result } = await renderHook(() => useHint(match, 'me', true, getHint));

    expect(result.current.available).toBe(true);
    expect(result.current.state.status).toBe('idle');
    expect(getHint).not.toHaveBeenCalled();

    await act(async () => result.current.ask());
    expect(result.current.state.status).toBe('loading');
    await act(async () => answer({ status: 'ready', hint }));
    await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', hint }));
    expect(result.current.hint).toEqual(hint);

    await act(async () => result.current.ask());
    expect(getHint).toHaveBeenCalledTimes(1);
  });

  it('drops the hint, and any answer still on its way, when the turn moves on', async () => {
    let answer!: (r: HintResponse) => void;
    const getHint = jest.fn(() => new Promise<HintResponse>((resolve) => (answer = resolve)));
    const first = practice();
    const { result, rerender } = await renderHook(({ match }: { match: MatchState }) => useHint(match, 'me', true, getHint), { initialProps: { match: first } });

    await act(async () => result.current.ask());
    await rerender({ match: placeBid(first, 'me', Bid.Pass) });
    await act(async () => answer({ status: 'ready', hint }));

    expect(result.current.state.status).toBe('idle');
    expect(result.current.hint).toBeNull();
  });

  it('is unavailable while paused (a pre-play is queued), outside practice, or with bots off', async () => {
    const getHint = jest.fn();
    expect((await renderHook(() => useHint(practice(), 'me', true, getHint, true))).result.current.available).toBe(false);
    expect((await renderHook(() => useHint({ ...practice(), mode: 'custom' }, 'me', true, getHint))).result.current.available).toBe(false);
    expect((await renderHook(() => useHint(practice(), 'me', false, getHint))).result.current.available).toBe(false);
  });

  it('shows why a hint failed', async () => {
    const getHint = jest.fn(async (): Promise<HintResponse> => ({ status: 'unavailable' }));
    const match = practice();
    const { result } = await renderHook(() => useHint(match, 'me', true, getHint));
    await act(async () => result.current.ask());
    await waitFor(() => expect(result.current.state).toEqual({ status: 'error', message: "Hints aren't available right now." }));
  });
});
