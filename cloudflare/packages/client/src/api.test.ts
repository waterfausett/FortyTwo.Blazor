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
});
