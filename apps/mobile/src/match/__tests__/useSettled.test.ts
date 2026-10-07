import { act, renderHook } from '@testing-library/react-native';
import { useSettled } from '../useSettled';

describe('useSettled', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('is settled straight away when on from the start', async () => {
    const { result } = await renderHook(() => useSettled(true, 500));
    expect(result.current).toBe(true);
  });

  it('settles only once on for the given time, and unsettles as soon as it turns off', async () => {
    const { result, rerender } = await renderHook(({ active }: { active: boolean }) => useSettled(active, 500), {
      initialProps: { active: false },
    });
    expect(result.current).toBe(false);

    await rerender({ active: true });
    expect(result.current).toBe(false);
    await act(async () => {
      jest.advanceTimersByTime(499);
    });
    expect(result.current).toBe(false);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);

    await rerender({ active: false });
    expect(result.current).toBe(false);
  });
});
