// Adds react-native-auth0's config plugin, which needs the Auth0 domain at build time to register
// the login callback URL scheme. Expo loads .env files before evaluating this, so the domain comes
// from the same EXPO_PUBLIC_AUTH0_DOMAIN the app reads at runtime (src/config.ts).
module.exports = ({ config }) => ({
  ...config,
  plugins: [
    ...(config.plugins ?? []),
    ['react-native-auth0', { domain: process.env.EXPO_PUBLIC_AUTH0_DOMAIN ?? '' }],
  ],
});
