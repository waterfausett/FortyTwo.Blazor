import { useAuth0 } from '@auth0/auth0-react';
import type { JSX, ReactNode } from 'react';
import { useEffect, useLayoutEffect } from 'react';

// Guards the whole app, chrome included: nothing renders until Auth0 has a user. Until then -
// while it checks for a session, and while loginWithRedirect is on its way out to Auth0 - the
// gate renders nothing and leaves index.html's splash (#app-splash) up; it removes the splash
// once there is something to show instead. The redirect carries the current path as
// `appState.returnTo` so a deep link (a shared match URL) survives the trip through Auth0
// (AppAuth0Provider's onRedirectCallback navigates back to it).
//
// If Auth0 reports an error (a denied or declined login, a stale callback URL, Auth0 unreachable)
// the gate stops and says so instead of redirecting again: bouncing straight back to the login
// page hides the reason, and a denial that recurs on every round trip would loop forever.
export function AuthGate({ children }: { children: ReactNode }): JSX.Element | null {
  const { isAuthenticated, isLoading, error, loginWithRedirect } = useAuth0();
  const ready = !isLoading && (isAuthenticated || error != null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !error) {
      const { pathname, search, hash } = window.location;
      loginWithRedirect({ appState: { returnTo: pathname + search + hash } });
    }
  }, [isLoading, isAuthenticated, error, loginWithRedirect]);

  // Layout effect, so the splash is gone in the same frame the app (or error) first paints.
  useLayoutEffect(() => {
    if (ready) {
      document.getElementById('app-splash')?.remove();
    }
  }, [ready]);

  if (error && !isAuthenticated) {
    // Retry from the path alone: after a failed callback the query string is Auth0's
    // ?error=...&state=..., which would be re-read as a callback on the way back.
    const retry = () => loginWithRedirect({ appState: { returnTo: window.location.pathname } });
    return (
      <div className="app-splash" role="alert">
        <p className="app-splash-name">Couldn't sign you in</p>
        <p className="app-splash-message">{error.message}</p>
        <button type="button" className="action-button" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }

  if (!ready) {
    return null;
  }

  return <>{children}</>;
}
