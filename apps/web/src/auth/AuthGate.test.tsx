import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authState, loginWithRedirectMock } = vi.hoisted(() => ({
  authState: { isLoading: true, isAuthenticated: false, error: undefined as Error | undefined },
  loginWithRedirectMock: vi.fn(),
}));

vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({ ...authState, loginWithRedirect: loginWithRedirectMock }),
}));

import { AuthGate } from './AuthGate';

function renderGate() {
  return render(
    <AuthGate>
      <nav>app chrome</nav>
    </AuthGate>,
  );
}

// Stands in for index.html's static splash.
function mountSplash(): void {
  const splash = document.createElement('div');
  splash.id = 'app-splash';
  document.body.appendChild(splash);
}

function splashIsUp(): boolean {
  return document.getElementById('app-splash') != null;
}

describe('AuthGate', () => {
  beforeEach(() => {
    loginWithRedirectMock.mockReset();
    authState.error = undefined;
    mountSplash();
    window.history.replaceState({}, '', '/match/abc?seat=2');
  });

  afterEach(() => {
    document.getElementById('app-splash')?.remove();
  });

  it('renders nothing and leaves the splash up while Auth0 is checking for a session', () => {
    Object.assign(authState, { isLoading: true, isAuthenticated: false });
    renderGate();

    expect(splashIsUp()).toBe(true);
    expect(screen.queryByText('app chrome')).toBeNull();
    expect(loginWithRedirectMock).not.toHaveBeenCalled();
  });

  it('keeps the splash up while redirecting to Auth0, carrying the current path along', () => {
    Object.assign(authState, { isLoading: false, isAuthenticated: false });
    renderGate();

    expect(splashIsUp()).toBe(true);
    expect(screen.queryByText('app chrome')).toBeNull();
    expect(loginWithRedirectMock).toHaveBeenCalledTimes(1);
    expect(loginWithRedirectMock).toHaveBeenCalledWith({
      appState: { returnTo: '/match/abc?seat=2' },
    });
  });

  it('renders the app and removes the splash once authenticated', () => {
    Object.assign(authState, { isLoading: false, isAuthenticated: true });
    renderGate();

    expect(screen.getByText('app chrome')).toBeTruthy();
    expect(splashIsUp()).toBe(false);
    expect(loginWithRedirectMock).not.toHaveBeenCalled();
  });

  it('shows why sign-in failed instead of redirecting again, and retries on request', () => {
    Object.assign(authState, {
      isLoading: false,
      isAuthenticated: false,
      error: new Error('Please verify your email before logging in.'),
    });
    window.history.replaceState({}, '', '/?error=access_denied&state=xyz');
    renderGate();

    expect(splashIsUp()).toBe(false);
    expect(screen.getByRole('alert').textContent).toContain(
      'Please verify your email before logging in.',
    );
    expect(screen.queryByText('app chrome')).toBeNull();
    expect(loginWithRedirectMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    // The callback's ?error=...&state=... is dropped so it isn't re-read as a callback.
    expect(loginWithRedirectMock).toHaveBeenCalledWith({ appState: { returnTo: '/' } });
  });
});
