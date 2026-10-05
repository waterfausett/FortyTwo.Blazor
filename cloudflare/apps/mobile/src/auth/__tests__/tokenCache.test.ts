import { EXPIRY_MARGIN_MS, clearCachedToken, getCachedToken } from '../tokenCache';

// A credentials manager that answers with token-1, token-2, ... each expiring an hour from t=0.
function credentials() {
  let calls = 0;
  return jest.fn(async () => ({ accessToken: `token-${++calls}`, expiresAt: 3600 }));
}

describe('getCachedToken', () => {
  beforeEach(() => clearCachedToken());

  it('asks the credentials manager once, then reuses the token', async () => {
    const fetch = credentials();
    expect(await getCachedToken(fetch, () => 0)).toBe('token-1');
    expect(await getCachedToken(fetch, () => 1000)).toBe('token-1');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('asks again once the token is near expiry', async () => {
    const fetch = credentials();
    await getCachedToken(fetch, () => 0);
    expect(await getCachedToken(fetch, () => 3600_000 - EXPIRY_MARGIN_MS)).toBe('token-2');
  });

  it('shares one request between callers arriving together', async () => {
    const fetch = credentials();
    const tokens = await Promise.all([getCachedToken(fetch, () => 0), getCachedToken(fetch, () => 0)]);
    expect(tokens).toEqual(['token-1', 'token-1']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('forgets the token when cleared, including one still on its way', async () => {
    const fetch = credentials();
    await getCachedToken(fetch, () => 0);
    clearCachedToken();
    expect(await getCachedToken(fetch, () => 0)).toBe('token-2');

    clearCachedToken();
    const inFlight = getCachedToken(fetch, () => 0);
    clearCachedToken();
    expect(await inFlight).toBe('token-3');
    expect(await getCachedToken(fetch, () => 0)).toBe('token-4');
  });

  it('asks again after a failure', async () => {
    const fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ accessToken: 'ok', expiresAt: 3600 });
    await expect(getCachedToken(fetch, () => 0)).rejects.toThrow('offline');
    expect(await getCachedToken(fetch, () => 0)).toBe('ok');
  });
});
