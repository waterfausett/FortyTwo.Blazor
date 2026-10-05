import { useCallback } from 'react';
import { CredentialsManagerError, CredentialsManagerErrorCodes, useAuth0 } from 'react-native-auth0';
import { clearCachedToken, getCachedToken } from '@/auth/tokenCache';

// Errors that mean the stored session can't be renewed: nothing stored, no refresh token, or the
// refresh token was rejected (expired or revoked). Signing in again is the only way out.
const REQUIRES_LOGIN: ReadonlySet<string> = new Set([
  CredentialsManagerErrorCodes.NO_CREDENTIALS,
  CredentialsManagerErrorCodes.NO_REFRESH_TOKEN,
  CredentialsManagerErrorCodes.RENEW_FAILED,
]);

export function requiresLogin(error: unknown): boolean {
  return error instanceof CredentialsManagerError && REQUIRES_LOGIN.has(error.type);
}

// The getToken every createApiClient/useMatchSocket caller passes in. The credentials manager
// returns the stored access token, renewing it with the refresh token when it has expired; it's
// kept in memory until shortly before then (tokenCache). When it can't be renewed, the stored
// credentials are cleared, which signs the user out: the root layout then shows the sign-in screen.
export function useGetToken(): () => Promise<string> {
  const { getCredentials, clearCredentials } = useAuth0();

  return useCallback(async () => {
    try {
      return await getCachedToken(() => getCredentials());
    } catch (error) {
      if (requiresLogin(error)) {
        clearCachedToken();
        await clearCredentials();
      }
      throw error;
    }
  }, [getCredentials, clearCredentials]);
}
