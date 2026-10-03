import { renderHook } from '@testing-library/react';
import { GenericError, MissingRefreshTokenError } from '@auth0/auth0-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAccessTokenSilentlyMock, loginWithRedirectMock } = vi.hoisted(() => ({
  getAccessTokenSilentlyMock: vi.fn(),
  loginWithRedirectMock: vi.fn(),
}));

vi.mock('@auth0/auth0-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@auth0/auth0-react')>();
  return {
    ...actual,
    useAuth0: () => ({
      getAccessTokenSilently: getAccessTokenSilentlyMock,
      loginWithRedirect: loginWithRedirectMock,
    }),
  };
});

// Fresh module per test so the once-only `redirecting` flag starts clear.
async function getToken(): Promise<() => Promise<string>> {
  vi.resetModules();
  const { useGetToken } = await import('./useGetToken');
  return renderHook(() => useGetToken()).result.current;
}

// Resolves to 'pending' if the promise hasn't settled after the microtask queue drains.
async function settle<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([promise, new Promise<'pending'>((r) => setTimeout(() => r('pending'), 0))]);
}

beforeEach(() => {
  getAccessTokenSilentlyMock.mockReset();
  loginWithRedirectMock.mockReset();
});

describe('useGetToken', () => {
  it('returns the access token', async () => {
    getAccessTokenSilentlyMock.mockResolvedValue('abc');

    expect(await (await getToken())()).toBe('abc');
  });

  it('sends the user to log in when the refresh token is missing, and leaves the caller waiting', async () => {
    getAccessTokenSilentlyMock.mockRejectedValue(new MissingRefreshTokenError('aud', 'openid'));
    const fetchToken = await getToken();

    expect(await settle(fetchToken())).toBe('pending');
    expect(await settle(fetchToken())).toBe('pending');
    expect(loginWithRedirectMock).toHaveBeenCalledTimes(1);
  });

  it('sends the user to log in when the refresh token is expired or revoked', async () => {
    getAccessTokenSilentlyMock.mockRejectedValue(new GenericError('invalid_grant', 'Unknown or invalid refresh token.'));

    expect(await settle((await getToken())())).toBe('pending');
    expect(loginWithRedirectMock).toHaveBeenCalledTimes(1);
  });

  it('comes back to the current page after logging in again', async () => {
    window.history.pushState({}, '', '/match/abc?seat=2#hand');
    getAccessTokenSilentlyMock.mockRejectedValue(new MissingRefreshTokenError('aud', 'openid'));

    await settle((await getToken())());
    expect(loginWithRedirectMock).toHaveBeenCalledWith({ appState: { returnTo: '/match/abc?seat=2#hand' } });
  });

  it('rethrows errors that logging in again would not fix', async () => {
    const error = new Error('network down');
    getAccessTokenSilentlyMock.mockRejectedValue(error);

    await expect((await getToken())()).rejects.toBe(error);
    expect(loginWithRedirectMock).not.toHaveBeenCalled();
  });
});
