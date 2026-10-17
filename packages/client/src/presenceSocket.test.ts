import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectPresenceSocket } from './presenceSocket';

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

  receive(frame: unknown) {
    this.emit('message', { data: JSON.stringify(frame) });
  }
}

describe('connectPresenceSocket', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the presence path with a token and reports each count', async () => {
    const onOnline = vi.fn();
    const dispose = connectPresenceSocket({ origin: 'wss://x', getToken: async () => 't', onOnline });
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(1));
    const socket = MockWebSocket.instances[0];
    expect(socket.url).toBe('wss://x/presence/ws?token=t');
    socket.receive({ type: 'online', online: 3 });
    socket.receive({ type: 'match', match: {} });
    expect(onOnline.mock.calls).toEqual([[3]]);
    dispose();
  });
});
