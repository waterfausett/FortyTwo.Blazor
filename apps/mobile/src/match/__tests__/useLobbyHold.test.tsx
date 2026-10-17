import { act, renderHook } from '@testing-library/react-native';
import { LOBBY_FULL_HOLD_MS } from '@fortytwo/client';
import { useLobbyHold } from '../useLobbyHold';

type Props = { searching: boolean; full: boolean };

describe('useLobbyHold', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('holds the lobby for LOBBY_FULL_HOLD_MS after the table fills', async () => {
    const { result, rerender } = await renderHook(({ searching, full }: Props) => useLobbyHold(searching, full), {
      initialProps: { searching: true, full: false },
    });
    expect(result.current).toBe(true);
    await rerender({ searching: false, full: true });
    expect(result.current).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(LOBBY_FULL_HOLD_MS - 1);
    });
    expect(result.current).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it('does not hold when the search ends without filling', async () => {
    const { result, rerender } = await renderHook(({ searching, full }: Props) => useLobbyHold(searching, full), {
      initialProps: { searching: true, full: false },
    });
    await rerender({ searching: false, full: false });
    expect(result.current).toBe(false);
  });

  it('does not hold at a table that was full on arrival', async () => {
    const { result } = await renderHook(({ searching, full }: Props) => useLobbyHold(searching, full), {
      initialProps: { searching: false, full: true },
    });
    expect(result.current).toBe(false);
  });
});
