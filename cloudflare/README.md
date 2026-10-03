# Forty-Two on Cloudflare

The Texas 42 domino game as a React app served by a Cloudflare Worker, which is also its API. Each
match lives in its own Durable Object, and a D1 database indexes matches for the lobby.

## Layout

An npm workspace:

| Path | What it is |
| --- | --- |
| `packages/rules` | `@fortytwo/rules`: the game's rules as pure functions over `MatchState`. The Worker enforces them; the web app uses them to show only legal bids, trumps and plays. |
| `packages/api-types` | `@fortytwo/api-types`: the JSON shapes the REST API sends, shared by the Worker and the web app. Types only. |
| `packages/client` | `@fortytwo/client`: the client code that doesn't depend on how the app draws - the REST wrapper, the match socket's reconnect loop, what a seated player can see and do in a match (`describeMatch`), and table-geometry and match-summary helpers. No browser-only APIs or React, so a native app can share it; each app passes in its API origin and wake-up signals. |
| `apps/worker` | `@fortytwo/worker`: the Hono API (`/api/*`), the match WebSocket (`/matches/:id/ws`), and `MatchDO`, the Durable Object that holds each match. |
| `apps/web` | `@fortytwo/web`: the Vite + React front end, signing in through Auth0. |
| `apps/mobile` | `@fortytwo/mobile`: the Expo (React Native) app, talking to the same Worker. Sign in, find or create a match, pick a seat, and play a full game by tap. See [Mobile app](#mobile-app). |

How a move travels: the web app calls a REST route; the route validates the body and calls the
match's `MatchDO` over Durable Object RPC; `MatchDO` applies the rule, saves the match, and
broadcasts it to every connected socket, each player seeing only their own hand. The route then
updates the D1 lobby index. Bot moves (a dev-only testing aid) run on the Durable Object's alarm.

## Setup

```sh
npm install
```

The Worker reads its settings from `apps/worker/.dev.vars` (gitignored):

| Variable | Purpose |
| --- | --- |
| `AUTH0_DOMAIN`, `AUTH0_AUDIENCE` | Validate players' access tokens. |
| `AUTH0_API_CLIENT_ID`, `AUTH0_API_CLIENT_SECRET`, `AUTH0_API_AUDIENCE` | Call Auth0's Management API for profiles and display names. |
| `ALLOWED_ORIGIN` | The web app's origin, for CORS. Defaults to `http://localhost:5173`. |
| `AUTO_PLAY_BOTS` | `true` lets players seat bots in open seats. Never set in a deployed environment. |
| `EXPO_ACCESS_TOKEN` | Only once "enhanced push security" is on for the Expo project: an Expo access token the Worker sends push notifications with (see [Push notifications](#push-notifications)). A secret: `npx wrangler secret put EXPO_ACCESS_TOKEN`. |
| `ANDROID_APP_FINGERPRINTS` | The Android app's signing-certificate SHA-256 fingerprints, comma-separated, for App Links (see [Invite links](#invite-links)). Not secret. |

The web app reads `apps/web/.env.local` (gitignored):

| Variable | Purpose |
| --- | --- |
| `VITE_AUTH0_DOMAIN`, `VITE_AUTH0_CLIENT_ID`, `VITE_AUTH0_AUDIENCE` | Auth0 sign-in. |
| `VITE_API_ORIGIN` | Where the Worker's REST API is, e.g. `http://localhost:8787`. Unset or empty means the page's own origin. |
| `VITE_WS_ORIGIN` | The same, for WebSockets, e.g. `ws://localhost:8787`. |

## Running locally

```sh
cd apps/worker && npm run dev   # wrangler dev, on :8787
cd apps/web && npm run dev      # vite, on :5173
```

Apply the D1 migrations to the local database once, and after adding a migration:

```sh
cd apps/worker && npx wrangler d1 migrations apply fortytwo --local
```

## Tests

Each package runs its own suite with `npm test`:

- `packages/rules`: unit tests, plus `test/characterization.test.ts`, which replays games recorded
  from the original C# engine.
- `packages/client`: unit tests for the shared client helpers. The match socket is exercised
  through the web app's `useMatchSocket` tests.
- `apps/worker`: runs inside workerd through `@cloudflare/vitest-pool-workers`, with real Durable
  Objects and D1. Auth0 is mocked.
- `apps/web`: component and hook tests under jsdom.
- `apps/mobile`: hook tests under `jest-expo`. `npm run typecheck` typechecks it.

`cd apps/web && npm run build` typechecks the web app along with the packages it references.

## Mobile app

`apps/mobile` is an Expo app using Expo Router. It shares `@fortytwo/rules`, `@fortytwo/api-types`
and `@fortytwo/client` with the web app, and calls the deployed (or a local) Worker. Tracking
issue: #27.

It signs in with `react-native-auth0`, which has native code, so it doesn't run in Expo Go. Run
it as a development build instead: `npx expo run:android` / `npx expo run:ios` locally (Android
Studio / Xcode), or in the cloud with EAS (see [Cloud builds with EAS](#cloud-builds-with-eas)).

Setup:

1. In Auth0, create a **Native** application in the same tenant, authorized for the same API
   audience, with refresh token rotation on. Its Allowed Callback and Logout URLs are
   `com.waterfausett.fortytwo.auth0://<AUTH0_DOMAIN>/ios/com.waterfausett.fortytwo/callback` and
   `com.waterfausett.fortytwo.auth0://<AUTH0_DOMAIN>/android/com.waterfausett.fortytwo/callback`.
2. Copy `apps/mobile/.env.example` to `apps/mobile/.env.local` and fill it in: the Worker's
   origin, and the Native application's Auth0 settings.
3. `cd apps/mobile && npx expo run:android` (or `run:ios`). Rebuild after changing the Auth0
   domain, since the login callback scheme is baked into the native project.

The app needs React 19.2.3, the version React Native 0.86 was built against, while the web app is
on a newer React. npm keeps the app's copy in `apps/mobile/node_modules`. Expo's Metro config
bundles that copy, and `apps/mobile/jest.config.js` maps `react` to it for tests.

Add native libraries with `npx expo install <package>`, which picks versions that match the Expo
SDK.

The app icon, Android's adaptive and themed icons, and the splash screen are the brand's tilted
4-2 domino on walnut. They're drawn as SVG in `apps/mobile/assets/icon/render.mjs`; after changing
it, run `node assets/icon/render.mjs` from `apps/mobile` to rewrite the SVGs and the PNGs that
`app.json` uses. It renders with Chromium through Playwright. Icons and the splash only change
with a new build, and the splash only shows properly in a preview or production build: a
development build shows its own.

### Building for Android on Windows

`npx expo run:android` needs Android Studio, plus three things set up on Windows:

- **Java 17 or later.** Gradle refuses to run on an older JDK ("Gradle requires JVM 17 or later").
  Use the one bundled with Android Studio: set `JAVA_HOME` to
  `C:\Program Files\Android\Android Studio\jbr` and put `%JAVA_HOME%\bin` ahead of any older Java
  on `Path`.
- **The Android SDK.** Gradle fails with "SDK location not found" until `ANDROID_HOME` points at
  it, by default `%LOCALAPPDATA%\Android\Sdk` (Android Studio → SDK Manager shows the location).
  Add `%ANDROID_HOME%\platform-tools` to `Path` too, so `adb devices` can see your phone.
- **Short paths.** The native build writes object files at very deep paths, and the `ninja.exe`
  that comes with the SDK's CMake can't handle paths over Windows' 260-character limit
  ("Filename longer than 260 characters"). Either clone the repo to a short path such as `C:\ft`,
  or turn on Windows long paths (the `LongPathsEnabled` registry setting, then reboot) and
  replace `%ANDROID_HOME%\cmake\<version>\bin\ninja.exe` with ninja 1.12 or later. Avoid a
  `subst` drive: npm links the `@fortytwo/*` packages by their real `C:\` path, which Metro then
  treats as outside the project ("Unable to resolve \"@fortytwo/rules\"").

After changing any of these, open a new terminal. If Gradle still uses the old settings, stop
its background process (`cd android && gradlew --stop`). After a failed native build, delete
`android\app\.cxx` before retrying. `android\` is generated and gitignored, so fix the machine's
setup rather than editing files in it.

### Cloud builds with EAS

EAS Build compiles the app on Expo's servers instead of your machine. That gives you a build
anyone can install from a link, and iOS builds without a Mac. `apps/mobile/eas.json` has three
profiles:

| Profile | What it builds | For |
| --- | --- | --- |
| `development` | A development build, like `expo run:android`, served by `npx expo start` | Working on the app without Android Studio |
| `preview` | A release build; on Android, an APK installable from a link | Testers and playing with friends |
| `production` | Store builds: an Android App Bundle and an iOS IPA, with the build number raised each time | Google Play and the App Store |

Builds don't see `.env.local`: it's gitignored, so it never leaves your machine. Each profile
reads its settings from the EAS environment of the same name (`development`, `preview` or
`production`), stored on expo.dev.

One-time setup, from `apps/mobile`:

1. Sign in with a free Expo account: `npx eas-cli@latest login`.
2. Link the project: `npx eas-cli@latest init`. This creates the project on expo.dev and writes
   its ID into `app.json` (`extra.eas.projectId`, and `owner`). Commit that.
3. Give each environment you'll build the app's settings, with the same names as in
   `.env.example`. Use plain-text visibility: `EXPO_PUBLIC_*` values are built into the app,
   so they're not secret. Either push a filled-in copy of `.env.example` (name it
   `.env.<environment>.local`, so git ignores it):

   ```sh
   npx eas-cli@latest env:push --environment preview --path .env.preview.local
   ```

   or set them one at a time:

   ```sh
   npx eas-cli@latest env:set --environment preview --visibility plaintext \
     --name EXPO_PUBLIC_API_ORIGIN --value https://<your worker>
   ```

   A preview or production build should point `EXPO_PUBLIC_API_ORIGIN` at the deployed Worker:
   a phone can't reach `wrangler dev` on your machine, except over your LAN.

Then build:

```sh
npx eas-cli@latest build --profile preview --platform android
```

The first Android build offers to create the app's signing key. Let EAS create and keep it, so
every build is signed with the same key: Android only installs an update over an app signed with
the same key. When the build finishes, the CLI
prints a link and a QR code; open it on the phone to install the APK. Android asks to allow
installs from that source the first time.

- The Auth0 Native application's callback URLs depend only on the package name and the Auth0
  domain, so release builds use the same ones as a development build.
- iOS builds need an Apple Developer account, and EAS asks to sign in to it to manage the
  certificates. To install an iOS preview build, the phone must be registered first:
  `npx eas-cli@latest device:create`.
- App versions: `version` in `app.json` is the version people see. The build number (Android's
  `versionCode`, iOS's `buildNumber`) is kept by EAS (`appVersionSource: remote`), and
  production builds raise it by one each time.
- EAS uploads the whole git repository, and installs the npm workspace from `cloudflare/`.
  Uncommitted changes are included; gitignored files aren't.
- EAS picks its build image from the Expo SDK version. SDK 57's image has Node 22 and npm 10,
  while CI uses Node 24. If a cloud build fails at installing dependencies, try pinning Node to
  match with `"node": "<version>"` in the profile.

### Invite links

A match waiting for players has an **Invite friends** button, which shares
`https://<worker>/match/<id>` through the phone's share sheet. Whoever opens it:

- with the app installed on Android, gets the match in the app (an Android App Link);
- otherwise, gets the web app, which signs them in and returns to the match.

Either way, someone who isn't seated sees the open seats to pick from, or that the match is full.
The app also opens `fortytwo://match/<id>`. A link opened while signed out opens once the player
has signed in.

Android only opens https links in the app once the Worker vouches for it:

1. Get the signing certificate's SHA-256 fingerprint: `npx eas-cli@latest credentials -p android`,
   then pick the build profile. Development builds made on your machine are signed with a
   different (debug) key, so their https links open in the browser; `fortytwo://` links work in
   every build.
2. Give the Worker the fingerprint (several can be listed, comma-separated). It isn't secret, so
   it can go in `apps/worker/wrangler.toml`:

   ```toml
   [vars]
   ANDROID_APP_FINGERPRINTS = "AB:CD:..."
   ```

   The Worker then serves `/.well-known/assetlinks.json`; without it, that's a 404.
3. Build the app with `EXPO_PUBLIC_API_ORIGIN` set to the Worker's https address.
   `app.config.js` registers that host for App Links; with an http origin it registers none.
   Android checks the Worker's file when the app is installed, so reinstall after changing it.

iOS Universal Links aren't set up yet: they need an Apple Developer team ID.

### Push notifications

The app is sent a push notification when it's the player's turn (to bid, name trump or play), a
hand they're in is decided, or a game of theirs starts (the last seat taken, or a rematch dealt).
None is sent for a match they have open: the app closes a match's socket in the background, and
`MatchDO` only notifies players without one (`apps/worker/src/push/`). Bots get none.

- **Asking:** the app asks for permission the first time the player sits at a match. Once
  allowed, it registers the device's Expo push token with the Worker (`PUT
  /api/users/push-tokens`, stored in D1's `push_tokens`). The token is removed on sign-out.
- **Turning them off:** the Notifications setting on the profile, on unless turned off. Each
  device of the player's unregisters when it next starts.
- **Opening one:** a notification opens its match, or the match opens once the player has
  signed in.
- **Sending:** the Worker sends through Expo's push service, and forgets a token Expo says is no
  longer registered.

Setup:

1. **Firebase, for Android.** Create a Firebase project, add an Android app to it with the
   package `com.waterfausett.fortytwo`, and download its `google-services.json` into
   `apps/mobile/`. It isn't secret, so commit it; `app.config.js` uses it when it's there.
2. **Firebase's key, for Expo.** In the Firebase console, open Project settings, then Service
   accounts, and generate a private key. Upload that JSON file to EAS: run
   `npx eas-cli@latest credentials -p android`, pick the build profile, then Google Service
   Account, then Push Notifications (FCM V1). The key *is* secret: don't commit it (files named
   `*firebase-adminsdk*.json` are gitignored).
3. **iOS** needs an Apple Developer account. EAS sets up the push key on the first iOS build
   (#49).
4. **The database:** CI applies the new D1 migration when it deploys. For `wrangler dev`, run
   `cd apps/worker && npx wrangler d1 migrations apply fortytwo --local`.
5. **Rebuild the app.** Push needs a build with `expo-notifications` and `google-services.json`.

Notifications only work in a real build; Expo Go can't receive them. To check one end to end,
copy the device's token from the `push_tokens` table and send a test from
[expo.dev/notifications](https://expo.dev/notifications).

## Deploying

The Worker serves the web app's build as static assets, so the whole game is one `wrangler deploy`
on one origin. `.github/workflows/cloudflare.yml` tests every pull request, and on a push to
`master` (or a manual run) builds the web app, applies new D1 migrations and deploys.

One-time setup:

1. `cd apps/worker && npx wrangler d1 create fortytwo`, and put the returned ID in `wrangler.toml`'s
   `database_id`.
2. Set the Worker's Auth0 secrets: `npx wrangler secret put AUTH0_DOMAIN`, and the same for
   `AUTH0_AUDIENCE`, `AUTH0_API_CLIENT_ID`, `AUTH0_API_CLIENT_SECRET` and `AUTH0_API_AUDIENCE`.
   `ALLOWED_ORIGIN` isn't needed, since the app and the API share an origin.
3. In GitHub, add the secrets `CLOUDFLARE_API_TOKEN` (the "Edit Cloudflare Workers" template, plus
   D1 edit) and `CLOUDFLARE_ACCOUNT_ID`, and the variables `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID` and
   `AUTH0_AUDIENCE` for the web build.
4. In the Auth0 SPA application, add the Worker's URL to Allowed Callback URLs, Allowed Web Origins
   and Allowed Logout URLs.

To deploy by hand instead, `cd apps/worker && npm run deploy` builds the web app and deploys. Its
build also loads `apps/web/.env.local`, so override its localhost origins in
`apps/web/.env.production.local` with empty values (`VITE_API_ORIGIN=` and `VITE_WS_ORIGIN=`), and
put the Auth0 settings there if they differ from dev.
