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
Studio / Xcode), or `npx eas-cli build --profile development` in the cloud.

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
