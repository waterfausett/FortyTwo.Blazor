// The connect/backoff loop's general behaviour is covered by apps/web's useMatchSocket tests. These
// cover a token fetch failing, against a mock WebSocket and fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectMatchSocket, type MatchSocketOptions } from './matchSocket';

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  private listeners: Record<string, Array<(event: unknown) => void>> = {};

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ??= []).push(listener);
  }

  close() {
    this.emit('close', { code: 1000 });
  }

  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

function connect(overrides: Partial<MatchSocketOptions>) {
  let wake: () => void = () => {};
  const options: MatchSocketOptions = {
    matchId: 'match-1',
    origin: 'wss://api.test.local',
    getToken: async () => 'test-token',
    onOpen: vi.fn(),
    onMatch: vi.fn(),
    onDrop: vi.fn(),
    subscribeWake: (w) => {
      wake = w;
      return () => {};
    },
    ...overrides,
  };
  const disconnect = connectMatchSocket(options);
  return { options, disconnect, wake: () => wake() };
}

describe('connectMatchSocket when getToken rejects', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reports a drop and retries with backoff', async () => {
    const getToken = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('test-token');
    const { options, disconnect } = connect({ getToken });

    await vi.advanceTimersByTimeAsync(0);
    expect(options.onDrop).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(options.onDrop).toHaveBeenCalledTimes(2);

    // Backoff doubled to 2s.
    await vi.advanceTimersByTimeAsync(1999);
    expect(getToken).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe('wss://api.test.local/matches/match-1/ws?token=test-token');

    disconnect();
  });

  it('lets a wake-up skip the pending retry', async () => {
    const getToken = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue('test-token');
    const { disconnect, wake } = connect({ getToken });
    await vi.advanceTimersByTimeAsync(0);

    wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(MockWebSocket.instances).toHaveLength(1);

    // The cancelled backoff timer must not open a second socket.
    await vi.advanceTimersByTimeAsync(5000);
    expect(MockWebSocket.instances).toHaveLength(1);

    disconnect();
  });

  it('does nothing if disconnected while the token was being fetched', async () => {
    let rejectToken: (error: Error) => void = () => {};
    const getToken = vi.fn(() => new Promise<string>((_, reject) => (rejectToken = reject)));
    const { options, disconnect } = connect({ getToken });

    disconnect();
    rejectToken(new Error('offline'));
    await vi.advanceTimersByTimeAsync(30000);

    expect(options.onDrop).not.toHaveBeenCalled();
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});
