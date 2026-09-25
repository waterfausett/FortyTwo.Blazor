// Tests useMatchSocket against a mock WebSocket (vi.stubGlobal), since jsdom has no real
// WebSocket server to connect to. Fake timers drive the exponential-backoff reconnect assertions.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchState } from '@fortytwo/rules';
import { useMatchSocket } from './useMatchSocket';

// Minimal event-emitter WebSocket stand-in. Tests drive it directly via `emit(...)` instead of
// simulating real network timing - the hook only cares about addEventListener/removeEventListener
// and the close event's `wasClean` flag, so that's all this needs to fake.
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
});
