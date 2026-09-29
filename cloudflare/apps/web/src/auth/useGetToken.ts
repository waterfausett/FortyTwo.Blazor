import { useAuth0, type GenericError } from '@auth0/auth0-react';

// Auth0 errors that mean the saved session can't be renewed silently - the cached entry has no
// refresh token, the refresh token expired or was revoked, or Auth0 wants the user to sign in
// again. Logging in again is the only way out, so send them there instead of surfacing an error.
const REQUIRES_LOGIN = new Set([
  'missing_refresh_token',
  'invalid_grant',
  'login_required',
  'consent_required',
  'interaction_required',
]);

// Matched on GenericError's `error` code rather than `instanceof`, which fails if the class ever
// comes from a second copy of auth0-spa-js.
export function requiresLogin(error: unknown): boolean {
  const code = (error as Partial<GenericError> | null)?.error;
  return typeof code === 'string' && REQUIRES_LOGIN.has(code);
}

// Several queries can fail at once on load; only the first should start the redirect.
let redirecting = false;

// The getToken every apiClient/useMatchSocket caller passes in. auth0-react's
// getAccessTokenSilently is typed to possibly resolve undefined, while apiClient wants a plain
// () => Promise<string> - fail loudly rather than send `Authorization: Bearer undefined`.
export function useGetToken(): () => Promise<string> {
  const { getAccessTokenSilently, loginWithRedirect } = useAuth0();

  return async () => {
    let token: string | undefined;
    try {
      token = await getAccessTokenSilently();
    } catch (error) {
      if (!requiresLogin(error)) throw error;
      if (!redirecting) {
        redirecting = true;
        void loginWithRedirect();
      }
      // The page is about to navigate away - leave the caller waiting rather than flashing an
      // error for a problem the redirect is already fixing.
      return new Promise<string>(() => {});
    }
    if (!token) throw new Error('Failed to obtain an access token.');
    return token;
  };
}
