// Tests useMatchSocket against a mock WebSocket (vi.stubGlobal), since jsdom has no real
// WebSocket server to connect to. Fake timers drive the exponential-backoff reconnect assertions.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchState } from '@fortytwo/rules';
import { useMatchSocket } from './useMatchSocket';

// Minimal event-emitter WebSocket stand-in. Tests drive it directly via `emit(...)` instead of
// simulating real network timing - the hook only cares about addEventListener/removeEventListener
// and the close event's `code`, so that's all this needs to fake.
class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0;
  private listeners: Record<string, Array<(event: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
  }

  send(_data: string) {}

  close() {
    this.readyState = 3;
    this.emit('close', { wasClean: true, code: 1000 });
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

// A structurally-minimal MatchState fixture - the hook treats the payload opaquely (it only
// parses JSON and checks `type`), so only identity/shape after the JSON round-trip matters here.
const MATCH_FIXTURE = {
  id: 'match-1',
  createdOn: '2026-01-01T00:00:00.000Z',
  updatedOn: '2026-01-01T00:00:00.000Z',
  currentGame: null,
  games: {},
  winningTeam: null,
  players: [],
} as unknown as MatchState;

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useMatchSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('connects to the correct WebSocket URL with the resolved auth token', async () => {
    const getToken = vi.fn(async () => 'test-token');
    const { unmount } = renderHook(() => useMatchSocket('match-1', getToken));

    await flush();

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe('wss://api.test.local/matches/match-1/ws?token=test-token');

    unmount();
  });

  it('marks connected on open and updates match state on a match message', async () => {
    const getToken = vi.fn(async () => 'test-token');
    const { result, unmount } = renderHook(() => useMatchSocket('match-1', getToken));
    await flush();
    const ws = MockWebSocket.instances[0];

    expect(result.current.connected).toBe(false);
    await act(async () => {
      ws.emit('open');
    });
    expect(result.current.connected).toBe(true);

    expect(result.current.match).toBeNull();
    await act(async () => {
      ws.emit('message', { data: JSON.stringify({ type: 'match', match: MATCH_FIXTURE }) });
    });
    expect(result.current.match).toEqual(MATCH_FIXTURE);

    unmount();
  });

  it('ignores messages that are not a match update', async () => {
    const getToken = vi.fn(async () => 'test-token');
    const { result, unmount } = renderHook(() => useMatchSocket('match-1', getToken));
    await flush();
    const ws = MockWebSocket.instances[0];

    await act(async () => {
      ws.emit('message', { data: JSON.stringify({ type: 'ping' }) });
    });
    expect(result.current.match).toBeNull();

    unmount();
  });

  it('reconnects with exponential backoff after an unexpected close', async () => {
    const getToken = vi.fn(async () => 'test-token');
    const { result, unmount } = renderHook(() => useMatchSocket('match-1', getToken));
    await flush();
    expect(MockWebSocket.instances).toHaveLength(1);

    await act(async () => {
      MockWebSocket.instances[0].emit('open');
    });
    expect(result.current.connected).toBe(true);

    // Unexpected close (server restart / network blip) - not a clean close.
    await act(async () => {
      MockWebSocket.instances[0].emit('close', { wasClean: false, code: 1006 });
    });
    expect(result.current.connected).toBe(false);
    // No reconnect attempt yet - it's scheduled behind the initial ~1s backoff delay.
    expect(MockWebSocket.instances).toHaveLength(1);

    await flush(999);
    expect(MockWebSocket.instances).toHaveLength(1);
    await flush(1);
    expect(MockWebSocket.instances).toHaveLength(2);

    // A second unexpected close should double the backoff to ~2s before the next retry.
    await act(async () => {
      MockWebSocket.instances[1].emit('close', { wasClean: false, code: 1006 });
    });
    await flush(1999);
    expect(MockWebSocket.instances).toHaveLength(2);
    await flush(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    unmount();
  });

  it('resets the backoff delay to the initial value after a successful reconnect', async () => {
    const getToken = vi.fn(async () => 'test-token');
    const { unmount } = renderHook(() => useMatchSocket('match-1', getToken));
    await flush();

    await act(async () => {
      MockWebSocket.instances[0].emit('open');
      MockWebSocket.instances[0].emit('close', { wasClean: false, code: 1006 });
    });
    await flush(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    // The reconnected socket opens successfully, resetting the backoff...
    await act(async () => {
      MockWebSocket.instances[1].emit('open');
      MockWebSocket.instances[1].emit('close', { wasClean: false, code: 1006 });
    });
    // ...so the NEXT retry should again be ~1s out, not ~2s.
    await flush(999);
    expect(MockWebSocket.instances).toHaveLength(2);
    await flush(1);
    expect(MockWebSocket.instances).toHaveLength(3);

    unmount();
  });

  it('does not reconnect after an intentional close triggered by unmount', async () => {
    const getToken = vi.fn(async () => 'test-token');
    const { unmount } = renderHook(() => useMatchSocket('match-1', getToken));
    await flush();
    expect(MockWebSocket.instances).toHaveLength(1);

    unmount();

    await flush(30000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('clears a pending reconnect timer on unmount so no stray reconnect happens later', async () => {
    const getToken = vi.fn(async () => 'test-token');
    const { unmount } = renderHook(() => useMatchSocket('match-1', getToken));
    await flush();

    await act(async () => {
      MockWebSocket.instances[0].emit('close', { wasClean: false, code: 1006 });
    });
    // A reconnect is now scheduled ~1s out - unmount before it fires.
    unmount();

    await flush(5000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  // A DO restart, a Worker deploy, or webSocketClose echoing the client's 1000 all close cleanly -
  // none of them mean "stop listening", so the page would otherwise freeze until a reload.
  it('stops reconnecting and reports the match deleted when the server closes with 4404', async () => {
    const getToken = vi.fn(async () => 'test-token');
    const { result, unmount } = renderHook(() => useMatchSocket('match-1', getToken));
    await flush();
    await act(async () => {
      MockWebSocket.instances[0].emit('open');
    });
    expect(result.current.deleted).toBe(false);

    await act(async () => {
      MockWebSocket.instances[0].emit('close', { wasClean: true, code: 4404 });
    });
    await flush(60_000);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(result.current.deleted).toBe(true);
    unmount();
  });

  it('reconnects after a clean close it did not initiate', async () => {
    const getToken = vi.fn(async () => 'test-token');
    const { result, unmount } = renderHook(() => useMatchSocket('match-1', getToken));
    await flush();

    await act(async () => {
      MockWebSocket.instances[0].emit('open');
      MockWebSocket.instances[0].emit('close', { wasClean: true, code: 1000 });
    });
    expect(result.current.connected).toBe(false);

    await flush(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    unmount();
  });

  describe('reconnecting', () => {
    it('is false during the first connect', async () => {
      const getToken = vi.fn(async () => 'test-token');
      const { result, unmount } = renderHook(() => useMatchSocket('match-1', getToken));
      await flush();

      expect(result.current.reconnecting).toBe(false);

      unmount();
    });

    it('turns on when the first connect fails, and off once a socket opens', async () => {
      const getToken = vi.fn(async () => 'test-token');
      const { result, unmount } = renderHook(() => useMatchSocket('match-1', getToken));
      await flush();

      // Never opened - e.g. the Worker is unreachable.
      await act(async () => {
        MockWebSocket.instances[0].emit('close', { wasClean: false, code: 1006 });
      });
      expect(result.current.reconnecting).toBe(true);

      await flush(1000);
      await act(async () => {
        MockWebSocket.instances[1].emit('open');
      });
      expect(result.current.reconnecting).toBe(false);
      expect(result.current.connected).toBe(true);

      unmount();
    });

    it('turns on when a live socket drops', async () => {
      const getToken = vi.fn(async () => 'test-token');
      const { result, unmount } = renderHook(() => useMatchSocket('match-1', getToken));
      await flush();

      await act(async () => {
        MockWebSocket.instances[0].emit('open');
        MockWebSocket.instances[0].emit('close', { wasClean: true, code: 1000 });
      });
      expect(result.current.reconnecting).toBe(true);

      unmount();
    });

    it('resets when matchId changes', async () => {
      const getToken = vi.fn(async () => 'test-token');
      const { result, rerender, unmount } = renderHook(({ id }) => useMatchSocket(id, getToken), {
        initialProps: { id: 'match-1' },
      });
      await flush();
      await act(async () => {
        MockWebSocket.instances[0].emit('close', { wasClean: false, code: 1006 });
      });
      expect(result.current.reconnecting).toBe(true);

      rerender({ id: 'match-2' });
      expect(result.current.reconnecting).toBe(false);

      unmount();
    });
  });

  it('resets match state when matchId changes so the previous match never renders', async () => {
    const getToken = vi.fn(async () => 'test-token');
    const { result, rerender, unmount } = renderHook(({ id }) => useMatchSocket(id, getToken), {
      initialProps: { id: 'match-1' },
    });
    await flush();

    await act(async () => {
      MockWebSocket.instances[0].emit('open');
      MockWebSocket.instances[0].emit('message', { data: JSON.stringify({ type: 'match', match: MATCH_FIXTURE }) });
    });
    expect(result.current.match).toEqual(MATCH_FIXTURE);
    expect(result.current.connected).toBe(true);

    rerender({ id: 'match-2' });
    expect(result.current.match).toBeNull();
    expect(result.current.connected).toBe(false);

    await flush();
    expect(MockWebSocket.instances[1].url).toBe('wss://api.test.local/matches/match-2/ws?token=test-token');

    unmount();
  });

  describe('reconnecting immediately when the page wakes up', () => {
    function setVisibility(state: DocumentVisibilityState) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    }

    afterEach(() => {
      setVisibility('visible');
    });

    it('skips the backoff when the tab becomes visible while disconnected', async () => {
      const getToken = vi.fn(async () => 'test-token');
      const { unmount } = renderHook(() => useMatchSocket('match-1', getToken));
      await flush();

      // Drive the backoff up to 2s so "immediately" is clearly distinguishable from it.
      await act(async () => {
        MockWebSocket.instances[0].emit('close', { wasClean: false, code: 1006 });
      });
      await flush(1000);
      await act(async () => {
        MockWebSocket.instances[1].emit('close', { wasClean: false, code: 1006 });
      });
      expect(MockWebSocket.instances).toHaveLength(2);

      setVisibility('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await flush();
      expect(MockWebSocket.instances).toHaveLength(3);

      // The pending backoff timer was cancelled - it must not open a fourth socket.
      await flush(5000);
      expect(MockWebSocket.instances).toHaveLength(3);

      unmount();
    });

    it('reconnects immediately when the browser comes back online', async () => {
      const getToken = vi.fn(async () => 'test-token');
      const { unmount } = renderHook(() => useMatchSocket('match-1', getToken));
      await flush();

      await act(async () => {
        MockWebSocket.instances[0].emit('close', { wasClean: false, code: 1006 });
      });
      await act(async () => {
        window.dispatchEvent(new Event('online'));
      });
      await flush();
      expect(MockWebSocket.instances).toHaveLength(2);

      unmount();
    });

    it('ignores the tab being hidden', async () => {
      const getToken = vi.fn(async () => 'test-token');
      const { unmount } = renderHook(() => useMatchSocket('match-1', getToken));
      await flush();
      await act(async () => {
        MockWebSocket.instances[0].emit('close', { wasClean: false, code: 1006 });
      });

      setVisibility('hidden');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await flush();
      expect(MockWebSocket.instances).toHaveLength(1);

      unmount();
    });

    it('does nothing while a socket is already open or still connecting', async () => {
      let resolveToken: (token: string) => void = () => {};
      const getToken = vi.fn(() => new Promise<string>((resolve) => (resolveToken = resolve)));
      const { unmount } = renderHook(() => useMatchSocket('match-1', getToken));

      // Still awaiting the token - a wake-up must not start a second connect.
      await act(async () => {
        window.dispatchEvent(new Event('online'));
      });
      expect(getToken).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveToken('test-token');
      });
      await flush();
      expect(MockWebSocket.instances).toHaveLength(1);

      // Socket exists (connecting or open) - still nothing to do.
      await act(async () => {
        MockWebSocket.instances[0].emit('open');
        window.dispatchEvent(new Event('online'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await flush();
      expect(MockWebSocket.instances).toHaveLength(1);

      unmount();
    });

    it('stops listening for wake-ups after unmount', async () => {
      const getToken = vi.fn(async () => 'test-token');
      const { unmount } = renderHook(() => useMatchSocket('match-1', getToken));
      await flush();
      unmount();

      await act(async () => {
        window.dispatchEvent(new Event('online'));
      });
      await flush();
      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });
});
