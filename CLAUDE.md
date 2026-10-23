# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

FortyTwo is a real-time multiplayer implementation of the Texas domino game [Forty-Two](https://en.wikipedia.org/wiki/Forty-two_(domino_game)). It is a Blazor WebAssembly app hosted on an ASP.NET Core server and deployed to Heroku via Docker.

## Commands

```bash
# Build the whole solution
dotnet build FortyTwo.sln

# Run the server (serves both API and Blazor WASM client)
dotnet run --project FortyTwo/Server/FortyTwo.Server.csproj

# Run all tests
dotnet test

# Run a specific test project
dotnet test FortyTwo.Tests/FortyTwo.Tests.csproj
dotnet test FortyTwo.Shared.Tests/FortyTwo.Shared.Tests.csproj

# Run a single test class or method (xUnit filter syntax)
dotnet test --filter "FullyQualifiedName~MatchServiceTests"
dotnet test --filter "FullyQualifiedName~MatchServiceTests.MethodName"

# Add a new EF Core migration
dotnet ef migrations add <MigrationName> --project FortyTwo.Entity --startup-project FortyTwo/Server
```

## Architecture

### Project Layout

| Project | Purpose |
|---|---|
| `FortyTwo/Server` | ASP.NET Core host — REST controllers, SignalR hub, DI wiring, middleware |
| `FortyTwo/Client` | Blazor WebAssembly — Razor pages/components, client-side state store |
| `FortyTwo/Shared` | Shared domain models, DTOs, game-logic services (runs on both sides) |
| `FortyTwo.Entity` | EF Core — `DatabaseContext`, PostgreSQL entity models, migrations |
| `FortyTwo.Tests` | Server integration tests (SQLite in-memory) |
| `FortyTwo.Shared.Tests` | Unit tests for shared game logic |

### Two Parallel Model Systems

There are **three distinct model families** — understanding when to use each is key:

- **`FortyTwo.Entity.Models`** — thin EF Core entities (`Match`, `MatchPlayer`) that map directly to Postgres tables. `Match.CurrentGame` and other game-state fields are stored as JSON columns.
- **`FortyTwo.Shared.Models`** — rich in-memory domain objects (`Game`, `Hand`, `Trick`, `Domino`, `Bid`, `Suit`). These contain all game rules and computed properties (e.g., `Game.WinningTeam`, `Game.Value`). Used server-side for game logic and deserialized from the JSON columns.
- **`FortyTwo.Shared.DTO`** — slimmed-down shapes sent over the wire to the client. AutoMapper profiles in `FortyTwo/Server/AutoMapper/MappingProfile.cs` define all entity → DTO conversions. `DTO.Hand` exposes domino *count* (not the actual dominos) to prevent cheating.

### Request Flow

```
Browser (Blazor WASM)
  ↕ REST (JWT-authenticated)       Controllers/ → Services/ → DatabaseContext
  ↕ SignalR (/gamehub)             GameHub.cs  → Clients.Group(matchId)
```

- All controllers require authentication (global `AuthorizeFilter` with `Policies.RequireAuthentication`).
- The `UserId` abstraction (`FortyTwo/Shared/Models/Security/UserId.cs`) is injected as scoped and resolved from the JWT via `HttpContextUserId`.
- SignalR groups are keyed by `matchId` (Guid). Clients call `JoinGameAsync(matchId)` on connect; the server pushes updates via `Clients.Group(matchId.ToString())`.

### Client-Side State

`ClientStore` (singleton, `FortyTwo/Client/Store/`) holds `ConcurrentDictionary` caches of `Match` and `User` DTOs. Pages mutate this store after API calls and SignalR events.

### Game Domain (Shared)

The game rules live entirely in `FortyTwo/Shared/`. Key types:

- `Domino` — identified by a hash of its two pip values (`Standart.Hash.xxHash`).
- `Suit` — includes `Low` as a special trump variant that inverts win conditions.
- `Game.WinningTeam` — computed property that evaluates trick points against the bid; handles both normal and `Low` trump rules.
- `DominoService` (shared) — deals and shuffles dominos using `ThreadSafeRandom`.

## Environment Variables

Required for local development (use [.NET User Secrets](https://learn.microsoft.com/en-us/aspnet/core/security/app-secrets) — secrets ID `a63a1982-d1b2-42f8-bb6a-45d4bcbe88c1`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Heroku-format PostgreSQL URL (`postgres://user:pass@host:port/db`) |
| `Auth0_Authority` | Auth0 domain |
| `Auth0_ApiAudience` | Auth0 API identifier |
| `Auth0_ClientId` | Blazor client app ID |
| `Auth0_ApiClient_ClientId` | M2M client ID (for Auth0 Management API calls) |
| `Auth0_ApiClient_ClientSecret` | M2M client secret |
| `Auth0_ApiClient_Audience` | Auth0 Management API audience |
| `Auth0_ApiClient_PublicOrigin` | Public URL of the deployed API |

## Testing Conventions

- `FortyTwo.Tests` uses SQLite in-memory via `SqliteTestBase` — inherit from it for any test that needs a real `DatabaseContext`.
- Services are tested directly (not via HTTP); dependencies are mocked with NSubstitute.
- `FortyTwo.Shared.Tests` tests pure domain logic with no DB or DI.

## Deployment

GitHub Actions (`.github/workflows/deploy-heroku.yml`) builds a Docker image from `Dockerfile` and pushes to Heroku Container Registry on every push to `master` or `release/*`. The `Dockerfile` is a standard multi-stage .NET build.
