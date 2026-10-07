// The connect/backoff loop itself is covered by apps/web's useMatchSocket tests (it lives in
// @fortytwo/client). These cover what's native: the URL built from config, the React state, and
// closing the socket in the background and reopening it in the foreground, and reconnecting
// straight away when the network comes back.
import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import type { MatchState } from '@fortytwo/rules';
import { useMatchSocket } from '../useMatchSocket';

jest.mock('@/config', () => ({ config: { wsOrigin: 'wss://api.test.local' } }));

let mockNetInfoListener: ((state: NetInfoState) => void) | null = null;
const mockUnsubscribeNetInfo = jest.fn();
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn((listener: (state: NetInfoState) => void) => {
      mockNetInfoListener = listener;
      return mockUnsubscribeNetInfo;
    }),
  },
}));

let appStateListener: ((state: AppStateStatus) => void) | null = null;
const removeAppStateListener = jest.fn();

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  private listeners: Record<string, ((event: unknown) => void)[]> = {};

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(listener);
  }

  closed = false;

  close() {
    this.closed = true;
    this.emit('close', { code: 1000 });
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

const MATCH = { id: 'match-1', players: [] } as unknown as MatchState;

async function flush(ms = 0) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

describe('useMatchSocket', () => {
  const realWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    jest.useFakeTimers();
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    appStateListener = null;
    mockNetInfoListener = null;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type: string, listener: unknown) => {
      appStateListener = listener as (state: AppStateStatus) => void;
      return { remove: removeAppStateListener };
    });
  });

  afterEach(() => {
    globalThis.WebSocket = realWebSocket;
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('connects to the configured origin and reports live match state', async () => {
    const { result } = await renderHook(() => useMatchSocket('match-1', async () => 'tok'));
    await flush();

    const ws = MockWebSocket.instances[0];
    expect(ws.url).toBe('wss://api.test.local/matches/match-1/ws?token=tok');

    await act(async () => {
      ws.emit('open');
      ws.emit('message', { data: JSON.stringify({ type: 'match', match: MATCH }) });
    });
    expect(result.current.connected).toBe(true);
    expect(result.current.match).toEqual(MATCH);
  });

  it('closes the socket in the background, so the Worker sends notifications, and reopens it on return', async () => {
    const { result } = await renderHook(() => useMatchSocket('match-1', async () => 'tok'));
    await flush();
    await act(async () => {
      MockWebSocket.instances[0].emit('open');
      MockWebSocket.instances[0].emit('message', { data: JSON.stringify({ type: 'match', match: MATCH }) });
    });

    await act(async () => appStateListener!('background'));
    await flush(60_000);
    expect(MockWebSocket.instances[0].closed).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(result.current.connected).toBe(false);
    // The last state stays on screen, ready for coming back.
    expect(result.current.match).toEqual(MATCH);

    await act(async () => appStateListener!('active'));
    await flush();
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('stays connected through a brief inactive moment', async () => {
    await renderHook(() => useMatchSocket('match-1', async () => 'tok'));
    await flush();
    await act(async () => appStateListener!('inactive'));
    await flush();
    expect(MockWebSocket.instances[0].closed).toBe(false);
  });

  it('reconnects immediately when the network comes back', async () => {
    await renderHook(() => useMatchSocket('match-1', async () => 'tok'));
    await flush();
    await act(async () => MockWebSocket.instances[0].emit('close', { code: 1006 }));

    await act(async () => mockNetInfoListener!({ isConnected: false } as NetInfoState));
    await flush();
    expect(MockWebSocket.instances).toHaveLength(1);

    await act(async () => mockNetInfoListener!({ isConnected: true } as NetInfoState));
    await flush();
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('reports the match deleted, and stops reconnecting, when the server closes with 4404', async () => {
    const { result } = await renderHook(() => useMatchSocket('match-1', async () => 'tok'));
    await flush();
    await act(async () => MockWebSocket.instances[0].emit('open'));
    expect(result.current.deleted).toBe(false);

    await act(async () => MockWebSocket.instances[0].emit('close', { code: 4404 }));
    await flush(60_000);

    expect(result.current.deleted).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('stops listening and closes the socket on unmount', async () => {
    const { unmount } = await renderHook(() => useMatchSocket('match-1', async () => 'tok'));
    await flush();
    await unmount();

    expect(removeAppStateListener).toHaveBeenCalled();
    expect(mockUnsubscribeNetInfo).toHaveBeenCalled();
    expect(MockWebSocket.instances[0].closed).toBe(true);
    await flush(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
