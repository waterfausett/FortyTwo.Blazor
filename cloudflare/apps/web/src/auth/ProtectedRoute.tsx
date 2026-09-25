import { useAuth0 } from '@auth0/auth0-react';
import type { JSX, ReactNode } from 'react';
import { useEffect } from 'react';

export function ProtectedRoute({ children }: { children: ReactNode }): JSX.Element {
  const { isAuthenticated, isLoading, loginWithRedirect } = useAuth0();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      loginWithRedirect();
    }
  }, [isLoading, isAuthenticated, loginWithRedirect]);

  if (isLoading) {
    return <div className="spinner" role="status" aria-label="Loading" />;
  }

  if (!isAuthenticated) {
    return <></>;
  }

  return <>{children}</>;
}
