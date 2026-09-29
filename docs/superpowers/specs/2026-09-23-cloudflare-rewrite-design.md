# FortyTwo Cloudflare Rewrite — Design

## Context

FortyTwo.Blazor is a hosted Blazor WebAssembly game (4-player domino trick-taking, "42") that ran on Heroku until its dynos were shut down. Rather than reviving the Heroku deployment, we're rewriting the app for Cloudflare (Workers + Durable Objects + Pages), with a React frontend. .NET 6 is EOL and SignalR's in-memory group state doesn't map onto a serverless/edge platform anyway, so this is a genuine rewrite, not a port-in-place.

The existing Blazor app (`FortyTwo/`, `FortyTwo.Entity/`, `FortyTwo.Tests/`, `FortyTwo.Shared.Tests/`) stays in the repo, untouched, as a live reference during the rewrite and a fallback if it stalls. It is not part of this spec's scope and nothing here modifies it.

## Goals

- Replace the Heroku-hosted Blazor/SignalR/EF/Postgres stack with Cloudflare Workers + Durable Objects + D1 + Pages, and a React/TypeScript frontend.
- Preserve the existing game rules exactly (42, including Low/nello and Plunge), verified via characterization tests against the current C# implementation.
- Keep Auth0 for authentication — no auth provider change.
- Fix the read-modify-write race in `MatchService` (concurrent EF saves against the same match) as a natural byproduct of moving match state into a single-threaded Durable Object, not as separate scoped work.

## Non-goals (deferred; tracked as GitHub issues)

- Live push for the lobby list — [#8](https://github.com/waterfausett/FortyTwo.Blazor/issues/8). v1 polls (interval + window focus).
- Optimistic client-side rule evaluation — [#9](https://github.com/waterfausett/FortyTwo.Blazor/issues/9). v1 client is thin; server is sole authority, same as today.
- Normalizing Durable Object storage beyond a single JSON blob per match — [#10](https://github.com/waterfausett/FortyTwo.Blazor/issues/10).
- Visual redesign / Tailwind — [#11](https://github.com/waterfausett/FortyTwo.Blazor/issues/11). v1 ports existing CSS as-is.

## Architecture

```
cloudflare/                          (new top-level folder, npm workspace)
├── apps/web        → React SPA, deployed to Cloudflare Pages
├── apps/worker     → Hono-on-Workers API + MatchDO, deployed via Wrangler
└── packages/rules  → pure TS: the 42 game rules, shared types/DTOs
                       (no Cloudflare or React dependency; importable by
                       apps/worker today, and by apps/web later if v-next
                       adds client-side validation — see #9)
```

Request flow: browser → Worker route (Hono) → Worker verifies the Auth0 JWT → resolves the match's Durable Object by ID (`idFromName(matchId)`) → DO validates the action, mutates its state, persists, and broadcasts the new state over WebSocket to everyone connected to that match. This is the same shape as today's Controller → `MatchService` → `IHubContext` broadcast, with the DO replacing both the EF-backed service and the SignalR hub's group-broadcast role.

One Durable Object instance exists per match. Because a DO is single-threaded, two simultaneous actions against the same match can no longer race each other — this eliminates the concurrent-write bug present in the current EF-based `MatchService` without any extra work.

## Backend: MatchDO

**State.** The entire `Match` aggregate (current game, past games keyed by winning team, players) is stored as a single value under one Durable Object storage key. This is a direct structural port of today's `current_game_json` / `games_json` JSON columns — no relational schema to design inside the DO for v1 (see deferred issue #10 if that ever needs to change).

**Connections.** WebSocket Hibernation API (`ctx.acceptWebSocket`) — sockets stay attached to the DO while it's evicted from memory between actions, so idle tables (the common case — four friends who aren't constantly moving) aren't billed for duration.

**Methods**, each a direct port of the corresponding `MatchService` method, running the matching `MatchValidationService` guards first and throwing a typed `ValidationError { title, detail }` on failure (replacing `CustomValidationException`):

| MatchDO method | Ports from |
|---|---|
| `create()` | `MatchService.CreateAsync` |
| `addPlayer(team)` | `MatchService.AddPlayerAsync` |
| `patchPlayer(request)` (ready-up, triggers new-game deal) | `MatchService.PatchPlayerAsync` / `ReadyUp` / `Deal` |
| `bid(bid)` | `MatchService.BidAsync` |
| `setTrump(suit)` | `MatchService.SetTrumpForCurrentGameAsync` |
| `playDomino(domino)` | `MatchService.PlayDominoAsync` |
| `getPlayerView(userId)` | `MatchService.GetPlayerForMatch` |

`MatchExtensions.SelectNextPlayer` (turn order, including the Low-trump partner-skip rule) and the `Match`/`Game`/`Trick`/`Domino` model logic (`WinningTeam`, `Value`, `IsFull`, `GetSuit`, `GetSuitValue`, etc.) move into `packages/rules` as plain functions/classes, imported by the DO.

## Worker routes

Hono routes replacing the existing controllers, all requiring a verified JWT except where noted:

| Route | Replaces |
|---|---|
| `POST /api/matches` | `MatchesController.Post` (create) |
| `GET /api/matches?filter=` | `MatchesController.Get` (list) — reads from D1, not the DO |
| `GET /api/matches/:id` | `MatchesController.Get(id)` |
| `DELETE /api/matches/:id` | `MatchesController.Delete` |
| `POST /api/matches/:id/players` | `MatchPlayersController.Post` (join) |
| `GET /api/matches/:id/players` | `MatchPlayersController.Get` |
| `PATCH /api/matches/:id/players` | `MatchPlayersController.Patch` (ready-up) |
| `PATCH /api/matches/:id/games/current` | `MatchGamesController.Patch` (set trump) |
| `POST /api/matches/:id/games/current/bids` | `MatchGamesController.PostBid` |
| `POST /api/matches/:id/games/current/moves` | `MatchGamesController.PostMove` |
| `GET /api/users/profile` | `UsersController.Profile` |
| `GET /api/users` | `UsersController.Get` |
| `POST /api/users/search` | `UsersController.Search` |
| `PATCH /api/users` | `UsersController.Patch` |
| `GET /matches/:id/ws` (upgrade) | `GameHub` (join/leave/broadcast for a match) |

Not ported: `MatchesController`'s `automoves` endpoint (already dead code, commented out in the source) and `AppSettingsController` (the Auth0 client config it serves becomes a Vite build-time env var — see Auth section below). `DominosController` (`GET /api/dominos`, `GET /api/dominos/hand`) is a low-priority parity item with no clear current use in the client; port only if something is found to depend on it.

Match/player-state-changing routes write a summary row to D1 (see below) after a successful DO call — this sync logic lives in the Worker route handlers, not inside the DO, keeping the DO focused purely on game state and connections.

## D1: lobby index

Two tables, mirroring the shape of Postgres's `matches`/`match_players` tables today (not just a flattened count — the `Joinable` filter excludes matches the requesting user has already joined, which needs per-player membership, not just a player count):

- `matches (id, status ('active'|'completed'), player_count, updated_on)`
- `match_players (match_id, player_id)`

`FetchForUserAsync`'s three filters port directly to SQL:
- **Active**: `matches` joined to `match_players` where `player_id = :userId AND status = 'active'`
- **Completed**: same join, `status = 'completed'`
- **Joinable**: `status = 'active' AND player_count < 4 AND id NOT IN (SELECT match_id FROM match_players WHERE player_id = :userId)`

Real SQL, strongly consistent (unlike Workers KV), avoiding the "match looks open but is actually full, or one I'm already in" class of bug a cache-based index would risk.

## Auth: Auth0, same provider, re-pointed

- New Auth0 **SPA application** (the current app is configured as a regular web app) with callback/logout/web-origin URLs pointed at the Pages domain.
- The Worker verifies the JWT on every request using Auth0's JWKS (`jose`, RS256, audience/issuer checks) — replacing `AddJwtBearer`; same trust boundary, same tokens.
- WebSocket upgrade requests can't carry a browser-set `Authorization` header, so the token is passed as a query param on the upgrade URL (`wss://.../matches/{id}/ws?token=...`) — the standard workaround for this constraint.
- The Auth0 Management API M2M flow (`Auth0ApiClient` + `Auth0AccessTokenProvider` — client-credentials grant, cached access token, used for profile fetch/search/patch) ports near-verbatim into a Worker module. Same env vars (`Auth0_ApiClient_ClientId/Secret/Audience`), now Worker secrets instead of Heroku config vars.

## Frontend

Vite + React + TypeScript SPA (not Next.js — this is static output talking to a separate Worker API, the same shape Blazor WASM already had; a server-rendering framework buys nothing here). React Router for `/`, `/match/:id`, `/profile`. TanStack Query for REST calls. A `useMatchSocket(matchId)` hook wrapping the native WebSocket API replaces the `HubConnection` singleton and its `.On<T>(...)` handlers. `@dnd-kit/core` replaces `BlazorSortableJs` for the hand's drag-to-reorder (and drops an unpinned `sortablejs@latest` CDN dependency the current app carries). Existing CSS (`theme.css`, `app.css`, `domino.css`, `chip.css`) ports as-is — see deferred issue #11 for a future redesign pass.

Domain: one custom domain. Pages serves everything except `/api/*` and `/matches/*/ws`, which route to the Worker — same-origin, no CORS to manage, matching the current single-origin Heroku setup.

## Testing

**Characterization tests as the port's acceptance spec.** Before porting any rule logic, add a small C# harness (throwaway, not a permanent test suite) in the existing repo that runs a handful of hand-authored deals through the real `MatchService`/`MatchValidationService` — deal → bid → Plunge → set trump → play a full hand, including at least one Low/nello game — and dumps the resulting `Match`/`Game` JSON after each step to fixture files. Vitest tests in `packages/rules` replay the identical action sequence against the TS port and diff against those fixtures. This converts "did I remember the rules correctly" into a pass/fail check, particularly for the fiddly bits: `Domino.GetSuitValue`'s trump/off-trump ranking, `Trick.IsFull` under Low (3 dominoes, not 4), `Game.WinningTeam`'s Low-vs-normal branching, and Plunge's partner-plays-first turn order.

**Unit tests** in `packages/rules` beyond the characterization fixtures, covering edge cases as they're found during the port.

## Deployment

- `apps/worker` deployed via Wrangler; `MATCHES` D1 binding, `MATCH_DO` Durable Object binding, Auth0 secrets via `wrangler secret`.
- `apps/web` deployed to Cloudflare Pages, build-time env vars for Auth0 client ID/domain/audience and the API origin.
- Both bound to one custom domain via Cloudflare routing rules (Worker owns `/api/*` and `/matches/*/ws`; Pages owns everything else).
- Single environment for v1 (no separate staging) — Wrangler environments can be added later if needed.
