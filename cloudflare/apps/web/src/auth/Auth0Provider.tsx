import { Auth0Provider } from '@auth0/auth0-react';
import type { AppState } from '@auth0/auth0-react';
import type { JSX, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { safeReturnTo } from './returnTo';

// Must sit inside <BrowserRouter>: returning from Auth0 navigates through the router, so the
// app lands on the page the visitor was sent to log in from (AuthGate's `appState.returnTo`),
// not the bare redirect_uri. A plain history.replaceState (the SDK's default) would change the
// URL without the router noticing.
export function AppAuth0Provider({ children }: { children: ReactNode }): JSX.Element {
  const navigate = useNavigate();

  const onRedirectCallback = (appState?: AppState): void => {
    navigate(safeReturnTo(appState?.returnTo), { replace: true });
  };

  return (
    <Auth0Provider
      domain={import.meta.env.VITE_AUTH0_DOMAIN}
      clientId={import.meta.env.VITE_AUTH0_CLIENT_ID}
      // Silent auth via the hidden iframe needs Auth0's session cookie, which browsers now block
      // as third-party — so every reload bounced back to the login page. Rotating refresh tokens
      // persisted in localStorage let a reload restore the session without the iframe.
      useRefreshTokens
      cacheLocation="localstorage"
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: import.meta.env.VITE_AUTH0_AUDIENCE,
      }}
      onRedirectCallback={onRedirectCallback}
    >
      {children}
    </Auth0Provider>
  );
}
