// Build-time settings, from EXPO_PUBLIC_* variables (see .env.example). Expo inlines these into the
// bundle, so they must be read as literal `process.env.EXPO_PUBLIC_...` expressions.
const apiOrigin = (process.env.EXPO_PUBLIC_API_ORIGIN ?? '').replace(/\/+$/, '');

export const config = {
  apiOrigin,
  // The Worker serves its WebSocket from the same host as the API.
  wsOrigin: apiOrigin.replace(/^http/, 'ws'),
  auth0Domain: process.env.EXPO_PUBLIC_AUTH0_DOMAIN ?? '',
  auth0ClientId: process.env.EXPO_PUBLIC_AUTH0_CLIENT_ID ?? '',
  auth0Audience: process.env.EXPO_PUBLIC_AUTH0_AUDIENCE ?? '',
};
