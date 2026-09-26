import { Auth0Provider } from '@auth0/auth0-react';
import type { JSX, ReactNode } from 'react';

export function AppAuth0Provider({ children }: { children: ReactNode }): JSX.Element {
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
    >
      {children}
    </Auth0Provider>
  );
}
