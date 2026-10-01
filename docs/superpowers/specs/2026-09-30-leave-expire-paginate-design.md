# Leave/Cancel Matches, Expire Idle Ones, Paginate the Lobby — Design

Tracks [#18](https://github.com/waterfausett/FortyTwo.Blazor/issues/18).

## Context

Nothing ever removes a match, and no player can ever leave one. A player who sits at a table that
never fills is stuck with it on Active Games; a creator can't take back a match nobody joined; a
match everyone walked away from stays `active` forever; and tables that never fill sit in Find a
Game forever. The three lobby queries in `lobby.ts` (`listActive`, `listCompleted`,
`listJoinable`) have no `LIMIT`, and every row they return costs an Auth0 name lookup in
`displayNames`, so the lobby slows down as history grows.

## Goals

- A seated player can leave a match before its first deal. When the last human leaves, the match
  is deleted - which is also how a creator cancels a match nobody joined.
- Active matches idle for more than 14 days are deleted by a daily scheduled sweep: their D1 lobby
  rows and their Durable Object storage.
- Lobby lists load one page (20 matches) at a time, with "Load more" for the rest.

## Non-goals

- Leaving after the deal. Once the 4th seat deals the first hand, everyone is committed; a match
  abandoned mid-game is cleaned up by expiry.
- An `abandoned` status or any record of expired matches. Expired matches are deleted outright
  (no migration of the `status` CHECK constraint, no new `MatchStatus`).
- Expiring completed matches. Game History is kept; paging keeps it cheap.
- Kicking another player, or a creator deleting a match others have joined.

## Rules engine (`packages/rules`)

A new pure function in `matchEngine.ts`:

```ts
export function removePlayer(match: MatchState, playerId: string): MatchState;
```

- Refuses (`ValidationError`) unless the match is active (`assertActive`), the caller is seated
  (`assertIsMatchPlayer`), and no hand has been dealt - checked as "every hand in
  `currentGame.hands` has no dominoes", not as `players.length < 4`, so a 4-seat table whose deal
  was skipped (no `dealOrder`) is still leavable and a dealt table never is.
- Removes the player from `players` and their hand from `currentGame.hands`; bumps `updatedOn`.
- If `currentGame.firstActionBy` or `currentGame.currentPlayerId` was the leaver, both move to the
  remaining player in the lowest seat (that's who `createMatch` would have made opener had they
  created it). If nobody remains, they are left as-is - the caller deletes the match.

A helper `hasHumanPlayers(match)` (bots per `isBot` / `botIds.ts`) tells the DO whether the match
should survive.

## Worker (`apps/worker`)

### Deleting a match

MatchDO gains a private `destroy()`:

1. `ctx.storage.deleteAlarm()` - a pending bot move must not fire on an empty DO.
2. Close every socket from `ctx.getWebSockets()` with code `4404`, reason `"Match deleted"`.
3. `ctx.storage.deleteAll()`.

`lobby.ts` gains `deleteFromLobbyIndex(db, matchId)`: one `db.batch` deleting the match's
`match_players` rows, then its `matches` row (child first, for the foreign key).

The DO never deletes its own D1 rows; whoever called it (the leave route or the sweep) does, as
routes already own D1 syncing.

### Leave

MatchDO:

```ts
leave(playerId: string): Promise<MatchResult<{ deleted: true } | MatchState>>;
```

Runs `removePlayer` through the existing `read` wrapper (so a rule violation is a 400 and a missing
match a 404). If the result still has a human, it is saved, broadcast, and handed to
`scheduleBotsIfNeeded` exactly as `update` does; otherwise `destroy()` runs and the result is
`{ deleted: true }`. DO input gating serializes this against a concurrent join: the join either
lands first (and the leave still succeeds, or is refused if the join dealt) or finds no match (404).

Route `DELETE /api/matches/:id/players`:

- `{ deleted: true }` → `deleteFromLobbyIndex`, reply `204`.
- A match → `syncLobbyIndex`, reply with `matchViewFor(match, caller)` (as `replyWithMatch` does).

### Expiry sweep

`wrangler.toml`:

```toml
[triggers]
crons = ["0 9 * * *"]   # daily, 09:00 UTC
```

`index.ts` exports `{ fetch: app.fetch, scheduled }` instead of `app`; `scheduled` calls
`ctx.waitUntil(expireIdleMatches(env, Date.now()))`.

New `src/expiry.ts`:

```ts
export const MATCH_IDLE_DAYS = 14;
export async function expireIdleMatches(env: Env, now: number): Promise<ExpirySummary>;
```

- `cutoff = new Date(now - 14 days).toISOString()`. `updated_on` holds ISO-8601 UTC strings, so
  string comparison is time comparison.
- Batches of `SELECT id FROM matches WHERE status = 'active' AND updated_on < ? ORDER BY updated_on
  LIMIT 100`, at most 10 batches per run; anything left waits for tomorrow.
- For each id, `stub.expire(cutoff)` on its MatchDO, which returns one of:
  - `{ outcome: 'expired' }` - its stored `updatedOn` is before `cutoff` and it is not completed;
    it ran `destroy()`.
  - `{ outcome: 'fresh', match }` - D1 was stale; the sweep runs `syncLobbyIndex(match)` so the row
    stops matching.
  - `{ outcome: 'missing' }` - no stored match (an orphaned index row).
- `expired` and `missing` → `deleteFromLobbyIndex`.
- Each match is handled in its own `try`; a failure is logged and the sweep moves on. Because a
  failed row still matches the query, the loop tracks ids it already tried this run and stops when
  a batch has nothing new, so one stuck DO can't spin the loop.
- Returns counts (`expired`, `refreshed`, `orphaned`, `failed`) and logs them.

### Migration

`migrations/0004_matches_status_updated.sql`:

```sql
CREATE INDEX idx_matches_status_updated ON matches(status, updated_on);
```

Serves both the sweep and the paged lobby queries. Additive only.

### Paged lobby lists

`GET /api/matches?filter=Active|Joinable|Completed&cursor=<opaque>` now returns:

```ts
// packages/api-types
export interface MatchPage {
  matches: MatchSummary[];
  nextCursor: string | null;
}
```

- Page size is fixed server-side at `LOBBY_PAGE_SIZE = 20`; there is no client `limit`.
- All three queries order by `updated_on DESC, id DESC` (Joinable drops its `player_count DESC`
  tie-break) and, given a cursor, add `AND (updated_on, id) < (?, ?)`. Each takes
  `LIMIT LOBBY_PAGE_SIZE + 1`; a 21st row means there's a next page, and its cursor is built from
  the 20th row.
- The cursor is base64url of `` `${updatedOn}|${id}` ``. One that doesn't decode to that shape is a
  `BadRequestError` (400, `{ title: 'Invalid cursor' }`).
- `listMatchPlayers` and `displayNames` now only see one page: at most 80 player ids, two Auth0
  calls at `MAX_USER_IDS = 50`.

This changes the response shape of an existing route. The Worker serves the web app's assets, so
both ship in one deploy.

## Web (`apps/web`)

### Lobby

- `client.listMatches(filter, cursor?)` returns `MatchPage`.
- `Lobby.tsx` switches to `useInfiniteQuery` keyed `['matches', activeTab]`, with
  `getNextPageParam: (page) => page.nextCursor ?? undefined`.
- Rows render from the pages flattened and de-duplicated by `id` (a match updated between page
  loads moves to page 1 and could otherwise appear twice).
- A "Load more" button under the list while `hasNextPage`; shows "Loading…" and is disabled while
  `isFetchingNextPage`.
- The refresh button refetches from the first page (`refetch()` on an infinite query refetches
  loaded pages; reset with `queryClient.resetQueries({ queryKey: ['matches', activeTab] })` so a
  refresh is one request).

### Leaving from the Match page

- In the waiting state (`.table-waiting`, shown while fewer than 4 are seated), a "Leave table"
  button beside "Fill with bots". When the caller is the only human seated it reads "Cancel match".
- Clicking it asks `window.confirm` ("Leave this table?" / "Cancel this match? It will be deleted."),
  then calls `client.leaveMatch(id)` (`DELETE`, empty 204 handled like the other bodyless calls),
  invalidates `['matches']`, and navigates to `/`.
- A refusal (e.g. the 4th player sat down first and the hand was dealt) shows as a toast with the
  error's title and detail; the player stays on the page.

### When the match goes away under you

- `useMatchSocket` adds `4404` to `NO_RECONNECT_CODES` and reports it (e.g. a `deleted` flag in its
  return value).
- On `deleted`, the Match page toasts "This match was deleted" and navigates to `/`.
- Today a failed `getMatch` (e.g. 404) leaves the page on its loading spinner forever: the spinner
  branch renders whenever `match` is null. The page now renders `matchQuery.error` as a
  `.match-error` alert with a link back to the lobby when there's no match to show. This also
  covers a completed match's `rematchId` pointing at a rematch that has since expired.

## Testing

- **Rules** (`matchEngine.test.ts`): `removePlayer` removes the seat and hand; reassigns
  `firstActionBy`/`currentPlayerId` when the creator leaves; refuses a non-player, a dealt table,
  and a completed match.
- **Worker** (vitest pool-workers, alongside `matchLifecycle.test.ts` / `routes.matches.test.ts`):
  - `DELETE /:id/players`: a joiner leaves (200, D1 seats updated); the last human leaves (204, D1
    rows gone, DO `getMatch` → 404, storage empty); a human leaving a table of bots deletes it;
    leaving after the deal → 400; a non-player → 400.
  - Sockets receive close code 4404 on delete.
  - `expireIdleMatches`: an old match is expired and both D1 rows and DO storage are gone; a match
    whose D1 row is stale but DO is fresh is re-synced and kept; an orphaned D1 row is removed;
    completed matches are untouched; a throwing DO doesn't stop the rest.
  - Paging: 21 matches → first page of 20 with a cursor, second page of 1 with `nextCursor: null`;
    ties on `updated_on` page correctly by `id`; a bad cursor → 400.
- **Web**: `Lobby.test.tsx` covers "Load more" appending and hiding at the end; `Match.test.tsx`
  covers the Leave/Cancel label and flow, the 4404 redirect, and the not-found error replacing
  the spinner; `useMatchSocket.test.ts` covers no reconnect on 4404.
