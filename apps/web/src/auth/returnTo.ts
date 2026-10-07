// Where to land after returning from Auth0 (AuthGate stores it as `appState.returnTo`). Only ever
// an in-app path: anything else (missing, or not starting with a single "/") goes to the Lobby.
export function safeReturnTo(returnTo: unknown): string {
  return typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//')
    ? returnTo
    : '/';
}
