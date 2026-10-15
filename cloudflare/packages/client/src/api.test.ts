import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, REQUEST_TIMEOUT_MS } from './api';

// A fetch that never answers until its signal aborts it, as a dead connection would.
function hangingFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createApiClient', () => {
  it('gives up on a request that takes too long', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(hangingFetch));
    const api = createApiClient(async () => 'token', '');

    const result = api.play('live').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    const error = await result;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).title).toBe('Request timed out');
  });

  it('answers a prompt request without timing out', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'm1' }), { status: 200 })));
    const api = createApiClient(async () => 'token', '');

    await expect(api.createMatch()).resolves.toEqual({ id: 'm1' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes other failures through as they are', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Network request failed'); }));
    const api = createApiClient(async () => 'token', '');

    await expect(api.createMatch()).rejects.toThrow('Network request failed');
  });

  it('sends house rules when creating a custom match, and no body without them', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: 'm1' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);
    const api = createApiClient(async () => 'token', '');
    const rules = { low: 'off', plunge: true, allPass: 'forceLast', marksToWin: 7 } as const;

    await api.createMatch(rules);
    await api.createMatch();

    const init = (call: number) => (fetchSpy.mock.calls[call] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init(0).body as string)).toEqual({ rules });
    expect(init(1).body).toBeUndefined();
  });
});
