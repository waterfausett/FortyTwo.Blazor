// The web app's binding of @fortytwo/client's REST wrapper: requests go to VITE_API_ORIGIN, which is
// unset in production, where the Worker serves the web app, so requests go to the same origin.
import { createApiClient } from '@fortytwo/client';

export { ApiError, type MatchPage, type MatchSummary, type PublicUser, type UserProfile } from '@fortytwo/client';

export function apiClient(getToken: () => Promise<string>) {
  return createApiClient(getToken, import.meta.env.VITE_API_ORIGIN ?? '');
}
