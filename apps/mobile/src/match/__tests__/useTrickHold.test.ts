import { act, renderHook } from '@testing-library/react-native';
import type { Game, Trick } from '@fortytwo/rules';
import { useTrickHold } from '../useTrickHold';

const trick = (n: number) => ({ playerId: `p${n}`, team: 1, suit: 1, dominoes: [] }) as unknown as Trick;
const game = (id: string, tricks: Trick[]) => ({ id, tricks }) as unknown as Game;

describe('useTrickHold', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('holds a newly completed trick, sweeps it, then lets it go', async () => {
    const { result, rerender } = await renderHook(({ g }: { g: Game }) => useTrickHold(g, 1000, 300), {
      initialProps: { g: game('g1', []) },
    });
    expect(result.current).toEqual({ heldTrick: null, sweeping: false });

    const done = trick(1);
    await rerender({ g: game('g1', [done]) });
    expect(result.current).toEqual({ heldTrick: done, sweeping: false });

    // The last 300ms of the hold, the trick sweeps off the table.
    await act(async () => {
      jest.advanceTimersByTime(700);
    });
    expect(result.current).toEqual({ heldTrick: done, sweeping: true });

    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(result.current).toEqual({ heldTrick: null, sweeping: false });
  });

  it("doesn't hold the tricks of a hand it opens on, or of a newly dealt hand", async () => {
    const { result, rerender } = await renderHook(({ g }: { g: Game }) => useTrickHold(g, 1000, 300), {
      initialProps: { g: game('g1', [trick(1), trick(2)]) },
    });
    expect(result.current.heldTrick).toBeNull();

    await rerender({ g: game('g2', [trick(3)]) });
    expect(result.current.heldTrick).toBeNull();
  });
});
