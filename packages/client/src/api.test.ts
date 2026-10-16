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

describe('people and invites', () => {
  it('sends each to its route', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = createApiClient(async () => 'token', 'https://w');

    await api.getPeople();
    await api.getPeople('friends');
    await api.getPeople('recent');
    await api.searchPeople('An n');
    await api.addFriend('auth0|a/b');
    await api.removeFriend('auth0|a');
    await api.invitePlayers('m1', ['auth0|a']);
    await api.getInvites();
    await api.dismissInvite('m1');

    const calls = fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit).method ?? 'GET'} ${url as string}`);
    expect(calls).toEqual([
      'GET https://w/api/people',
      'GET https://w/api/people?show=friends',
      'GET https://w/api/people?show=recent',
      'GET https://w/api/people/search?q=An%20n',
      'PUT https://w/api/people/friends/auth0%7Ca%2Fb',
      'DELETE https://w/api/people/friends/auth0%7Ca',
      'POST https://w/api/matches/m1/invites',
      'GET https://w/api/invites',
      'DELETE https://w/api/invites/m1',
    ]);
    expect(JSON.parse((fetchMock.mock.calls[6][1] as RequestInit).body as string)).toEqual({ userIds: ['auth0|a'] });
  });
});
