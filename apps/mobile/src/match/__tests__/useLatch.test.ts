import { renderHook } from '@testing-library/react-native';
import { useLatch } from '../useLatch';

describe('useLatch', () => {
  it('stays on once triggered until no longer active', async () => {
    const { result, rerender } = await renderHook(
      ({ trigger, active }: { trigger: boolean; active: boolean }) => useLatch(trigger, active),
      { initialProps: { trigger: false, active: true } }
    );
    expect(result.current).toBe(false);

    await rerender({ trigger: true, active: true });
    expect(result.current).toBe(true);
    await rerender({ trigger: false, active: true });
    expect(result.current).toBe(true);

    await rerender({ trigger: false, active: false });
    expect(result.current).toBe(false);
    await rerender({ trigger: false, active: true });
    expect(result.current).toBe(false);
  });
});
