import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { LOBBY_FULL_HOLD_MS } from '@fortytwo/client';
import { useLobbyHold } from './useLobbyHold';

type Props = { searching: boolean; full: boolean };

describe('useLobbyHold', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('holds the lobby for LOBBY_FULL_HOLD_MS after the table fills', () => {
    const { result, rerender } = renderHook(({ searching, full }: Props) => useLobbyHold(searching, full), {
      initialProps: { searching: true, full: false },
    });
    expect(result.current).toBe(true);
    rerender({ searching: false, full: true });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(LOBBY_FULL_HOLD_MS - 1);
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it('does not hold when the search ends without filling', () => {
    const { result, rerender } = renderHook(({ searching, full }: Props) => useLobbyHold(searching, full), {
      initialProps: { searching: true, full: false },
    });
    rerender({ searching: false, full: false });
    expect(result.current).toBe(false);
  });

  it('does not hold at a table that was full on arrival', () => {
    const { result } = renderHook(({ searching, full }: Props) => useLobbyHold(searching, full), {
      initialProps: { searching: false, full: true },
    });
    expect(result.current).toBe(false);
  });
});
