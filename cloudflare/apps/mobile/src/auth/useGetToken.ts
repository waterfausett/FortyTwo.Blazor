import { useCallback } from 'react';
import { CredentialsManagerError, CredentialsManagerErrorCodes, useAuth0 } from 'react-native-auth0';

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
// returns the stored access token, renewing it with the refresh token when it has expired. When
// it can't, the stored credentials are cleared, which signs the user out: the root layout then
// shows the sign-in screen.
export function useGetToken(): () => Promise<string> {
  const { getCredentials, clearCredentials } = useAuth0();

  return useCallback(async () => {
    try {
      const { accessToken } = await getCredentials();
      return accessToken;
    } catch (error) {
      if (requiresLogin(error)) await clearCredentials();
      throw error;
    }
  }, [getCredentials, clearCredentials]);
}
