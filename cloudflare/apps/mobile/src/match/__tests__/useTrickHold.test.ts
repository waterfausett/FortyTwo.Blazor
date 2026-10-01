import { act, renderHook } from '@testing-library/react-native';
import type { Game, Trick } from '@fortytwo/rules';
import { useTrickHold } from '../useTrickHold';

const trick = (n: number) => ({ playerId: `p${n}`, team: 1, suit: 1, dominoes: [] }) as unknown as Trick;
const game = (id: string, tricks: Trick[]) => ({ id, tricks }) as unknown as Game;

describe('useTrickHold', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('holds a newly completed trick, then lets it go', async () => {
    const { result, rerender } = await renderHook(({ g }: { g: Game }) => useTrickHold(g, 1000), {
      initialProps: { g: game('g1', []) },
    });
    expect(result.current).toBeNull();

    const done = trick(1);
    await rerender({ g: game('g1', [done]) });
    expect(result.current).toBe(done);

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(result.current).toBeNull();
  });

  it("doesn't hold the tricks of a hand it opens on, or of a newly dealt hand", async () => {
    const { result, rerender } = await renderHook(({ g }: { g: Game }) => useTrickHold(g, 1000), {
      initialProps: { g: game('g1', [trick(1), trick(2)]) },
    });
    expect(result.current).toBeNull();

    await rerender({ g: game('g2', [trick(3)]) });
    expect(result.current).toBeNull();
  });
});
