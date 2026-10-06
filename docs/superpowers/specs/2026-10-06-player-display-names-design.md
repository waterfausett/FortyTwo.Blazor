# Player display names: D1 cache and no raw ids on match screens

Issue: [#72](https://github.com/waterfausett/FortyTwo.Blazor/issues/72)

## Goal

Match screens (web and mobile) never show a raw player id (`auth0|64f…`). Names come from a D1
table instead of an Auth0 Management API call on every lookup, which also takes Auth0 rate limits
out of the busiest paths.

Success looks like:

- While a name loads, the screen shows a skeleton (or name-less wording), never the id.
- If a name can't be found, the screen shows "Player N" (N = seat position + 1), never the id.
- Someone joining a match only costs a lookup of the newcomer; names already shown stay shown.
- `POST /api/users/search` and the lobby read names from D1 and only reach Auth0 for players D1
  hasn't seen yet.
- Bots show as "Bot 1", "Bot 2", "Bot 3".

## Decisions

- One spec, one PR: server and client together.
- Names do **not** travel with the match (no change to `MatchState`, `matchViewFor` or the
  MatchDO broadcast). The client keeps looking them up through `POST /api/users/search`.
- Bot names come from the server.
- Loading shows a skeleton; failure shows "Player N".

## Out of scope

- Account deletion: no deletion route exists anywhere yet. The migration carries a comment that
  deleting an account must delete its `users` row.
- An Auth0 post-login Action to catch renames made outside the app.
- Naming players in push text ("[poker] poked you") - cheap once this lands, but separate.
- Moving settings (`highlightPlayable`, `pushNotifications`, `theme`) out of Auth0.

## Server (Worker + D1)

### Migration `0007_users.sql`

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,          -- Auth0 user id (the token's `sub`)
  display_name TEXT NOT NULL,   -- toUserResponse's resolved displayName
  picture TEXT,                 -- toUserResponse's effective picture
  updated_on TEXT NOT NULL
);
```

Holds only what any player may see of another (`PublicUser`). The header comment notes that
deleting an account must delete its row.

### `apps/worker/src/users/publicUsers.ts`

- `saveUser(db, user: PublicUser)`: upsert that only writes when something changed:
  `INSERT … ON CONFLICT(id) DO UPDATE SET … WHERE users.display_name IS NOT excluded.display_name
  OR users.picture IS NOT excluded.picture` (same idea as `saveToken`).
- `publicUsers(env, ids): Promise<PublicUser[]>`:
  1. Bots (`isBot`) -> `{ user_id, displayName: botDisplayName(id), picture: undefined }`, no
     lookup.
  2. Everyone else: one `SELECT id, display_name, picture FROM users WHERE id IN (…)`.
  3. Ids D1 misses: Auth0 `getUsers` in chunks of `MAX_USER_IDS`; each result is mapped with
     `toPublicUser` and saved with `saveUser`.
  4. If Auth0 fails, log and return what D1 (and bots) gave. Ids that couldn't be resolved are
     left out of the result.

`botDisplayName(id)` lives in `packages/rules/src/botIds.ts` next to `BOT_IDS`: `bot-1` ->
`Bot 1`.

### Routes

- `GET /api/users/profile`: after fetching from Auth0, `saveUser(toPublicUser(user))`. This is
  how D1 catches up with renames made outside the app (each app fetches the profile at launch).
- `PATCH /api/users`: `updateUser` returns the updated `Auth0User` (Auth0's PATCH replies with
  it; today the function returns `void`), and the route saves `toPublicUser(updated)`.
- `POST /api/users/search`: becomes `publicUsers(env, ids)`. Validation (`readUserIds`) stays.
- Lobby (`GET /api/matches`): `displayNames` in `routes/matches.ts` becomes a thin wrapper over
  `publicUsers`, so lobby lists read D1 and get bot names too.

### Server tests

- A name in D1 is returned without calling Auth0.
- A D1 miss calls Auth0 and saves the result.
- `GET /profile` with an unchanged name and picture doesn't rewrite the row (`updated_on`
  unchanged); a changed one does.
- `PATCH /api/users` updates the row.
- Bots get "Bot N" from search and the lobby.
- When Auth0 fails, search returns only what D1 has, and the lobby still lists.

## Client (web + mobile)

### Shared, pure: `packages/client/src/playerNames.ts`

No React, the same split as `poke.ts` and each app's `usePoke`.

```ts
export type PlayerName =
  | { status: 'loaded'; name: string }
  | { status: 'loading' }
  | { status: 'failed'; name: string }; // "Player N"

export function playerName(
  playerId: string,
  ctx: {
    myPlayerId: string | null;
    players: readonly { playerId: string; position: number }[];
    names: ReadonlyMap<string, string> | undefined; // current data, or the previous key's while loading
    settled: boolean; // the lookup for the current seated ids succeeded (query success, not placeholder data)
    failed: boolean;  // the lookup for the current seated ids errored
  }
): PlayerName;

export function missingIds(ids: readonly string[], known: ReadonlyMap<string, string>): string[];
export function mergeNames(...maps: (ReadonlyMap<string, string> | undefined)[]): Map<string, string>;
```

How `playerName` decides:

- The viewer is always `loaded` "You".
- In `names` -> `loaded`.
- Not in `names`, and `settled` or `failed` -> `failed` "Player N" from the player's seat
  position. An id missing from a
  successful reply counts as failed, so the raw id never shows.
- Otherwise `loading`.

A small `nameText(name: PlayerName): string | null` returns the name or "Player N", and `null`
while loading, for callers that build strings.

### Per-app hook: `usePlayerNames(players, myPlayerId)`

In `apps/web/src/match/usePlayerNames.ts` and `apps/mobile/src/match/usePlayerNames.ts`, next to
`usePoke`.

- One `useQuery({ queryKey: ['playerNames', sortedIds], … })`, the same key shape as today.
- The `queryFn` merges every cached `['playerNames', …]` map
  (`queryClient.getQueriesData`), calls `searchUsers` only for `missingIds`, and returns the
  merged map. A join therefore fetches only the newcomer.
- `placeholderData: keepPreviousData` keeps names on screen while the new key loads.
- `staleTime: Infinity`, as today.
- Returns `{ nameFor(id: string): PlayerName, ready: boolean }`. `ready` means no seated player
  is `loading`.

### What each place shows

| Place | Loading | Failed |
|---|---|---|
| Seat plates, seat picker | `NameSkeleton` in the name slot | "Player N" |
| Status line (`matchStatus`), contract line ("Bid 30 · …") | `NameSkeleton` in place of the whole line until `ready` | "Player N" |
| Poke button | Hidden until the target's name has loaded | "Poke Player N" |
| "… poked you" toast | "You were poked" | "Player N poked you" |
| "Poked …" toast | "Poked" | "Poked Player N" |
| New-hand toast, web ("… bids first") | "New hand dealt" | "Player N bids first" |

`NameSkeleton` is a new small component in each app (web: a CSS shimmer `span`; mobile: an
animated `View`), sized to read as text. `matchStatus` and the other string builders keep their
`nameFor: (id) => string` signature; the Match screens pass `nameText` with a fallback only after
checking `ready`.

The two inline `['playerNames']` queries, every `names.get(id) ?? id` fallback, and
`pokedRef.names` go. `pokedRef` holds `nameFor` instead. `usePoke`'s name callback returns
`string | null` (null while loading) so its toasts can choose the name-less wording.

The mobile dev fake (`apps/mobile/src/dev/devMatches.ts`) returns "Bot N" for bot ids, to match
the server.

### Client tests

- `playerNames.test.ts`: loaded, loading, failed (error and missing id), "You", "Player N" from
  the seat position, `missingIds`, `mergeNames`.
- One hook test per app: after a join, `searchUsers` is called with only the newcomer, and the
  names already shown stay `loaded` meanwhile.
- `usePoke` tests (both apps) and Match/seat picker tests updated for the name-less wording and
  the skeleton.
- Look at the mobile match screen in the emulator (`mobile-emulator` skill) with a slow
  `searchUsers` to check the skeletons.
