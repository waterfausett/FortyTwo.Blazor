# Forty-Two on Cloudflare

The Texas 42 domino game as a React app on Cloudflare Pages, backed by a Cloudflare Worker. Each
match lives in its own Durable Object, and a D1 database indexes matches for the lobby.

## Layout

An npm workspace:

| Path | What it is |
| --- | --- |
| `packages/rules` | `@fortytwo/rules`: the game's rules as pure functions over `MatchState`. The Worker enforces them; the web app uses them to show only legal bids, trumps and plays. |
| `packages/api-types` | `@fortytwo/api-types`: the JSON shapes the REST API sends, shared by the Worker and the web app. Types only. |
| `apps/worker` | `@fortytwo/worker`: the Hono API (`/api/*`), the match WebSocket (`/matches/:id/ws`), and `MatchDO`, the Durable Object that holds each match. |
| `apps/web` | `@fortytwo/web`: the Vite + React front end, signing in through Auth0. |

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
| `VITE_API_ORIGIN` | Where the Worker's REST API is, e.g. `http://localhost:8787`. |
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
- `apps/worker`: runs inside workerd through `@cloudflare/vitest-pool-workers`, with real Durable
  Objects and D1. Auth0 is mocked.
- `apps/web`: component and hook tests under jsdom.

`cd apps/web && npm run build` typechecks the web app along with the packages it references.

## Deploying

`apps/worker/wrangler.toml` still holds placeholders: set the real `database_id` (from
`wrangler d1 create fortytwo`) and the route patterns' domain before `npm run deploy`, and add the
Auth0 settings above with `wrangler secret put`.
