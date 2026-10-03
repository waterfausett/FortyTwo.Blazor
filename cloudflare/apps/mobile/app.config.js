// Settings that come from the environment at build time. Expo loads .env files before evaluating
// this (and EAS Build its environment's variables), so these are the same EXPO_PUBLIC_* values the
// app reads at runtime (src/config.ts).
//
// - react-native-auth0's config plugin needs the Auth0 domain to register the login callback.
// - Android App Links: links to matches on the Worker (https://<worker>/match/<id>, the invite
//   links the app shares) open in the app when it's installed. Android only trusts this once the
//   Worker vouches for the app at /.well-known/assetlinks.json; until then such links still open
//   in the browser. Only for an https Worker, since Android won't verify anything else.
// - Push notifications on Android go through Firebase, which needs the app registered with the
//   Firebase project: google-services.json, from the Firebase console. Not a secret, so it can be
//   committed. Without it the app builds, but gets no push token.
const fs = require('node:fs');
const path = require('node:path');

const GOOGLE_SERVICES_FILE = './google-services.json';

function appLinksHost() {
  const origin = process.env.EXPO_PUBLIC_API_ORIGIN ?? '';
  return origin.startsWith('https://') ? new URL(origin).host : null;
}

module.exports = ({ config }) => {
  const host = appLinksHost();
  return {
    ...config,
    android: {
      ...config.android,
      ...(fs.existsSync(path.join(__dirname, GOOGLE_SERVICES_FILE)) ? { googleServicesFile: GOOGLE_SERVICES_FILE } : {}),
      intentFilters: host
        ? [
            {
              action: 'VIEW',
              autoVerify: true,
              data: [{ scheme: 'https', host, pathPrefix: '/match/' }],
              category: ['BROWSABLE', 'DEFAULT'],
            },
          ]
        : [],
    },
    plugins: [
      ...(config.plugins ?? []),
      ['react-native-auth0', { domain: process.env.EXPO_PUBLIC_AUTH0_DOMAIN ?? '' }],
    ],
  };
};
