# Recent players and friends — design

Issue: #116. Related: private / invite-only matches (#84).

## Goal

Inviting someone to a table today means sharing a link outside the app, and nothing remembers who
you've played with. This adds, on web and mobile:

- a **People** list in the Lobby: your friends, then the people you've recently played with, plus
  a name search;
- **friends** — a star that pins someone to the top of your lists;
- **invites** from inside a Custom Match with open seats, delivered as a push notification and as
  an "Invited to" card in the invitee's Lobby.

## Decisions (settled with the owner)

- **All three pieces in one design**: recent players, friends + name search, invites.
- **Invite only from inside a table.** The Lobby's People list has no Invite button; you create a
  Custom Match first, then invite from the table. Only `custom` matches take invites (Live and
  Async fill through the matchmaker; vs Bots has no open seats).
- **Friends are one-way**, like a favourite: adding someone pins them for you only. No requests,
  no accept/decline, and the other person isn't told.
- **Invites are stored**, not push-only: web players (who have no push) and anyone who missed the
  notification see them in the Lobby until they're used or stale.
- **An invite reserves nothing.** Custom tables stay public (Joinable) — making them invite-only is
  #84.
- **Recent players come from a new `played_with` table** written when a game starts, not from
  querying `match_players` (whose rows vanish when a match expires or is dropped, and which would
  list one person once per match). Backfilled once from `match_players`.
- **Spam limits:** one invite per invitee per table, at most 6 invites per table.

## Data — migration `0012_people.sql`

```sql
-- Who has sat at a started game with whom (#116): one row per direction, humans only.
CREATE TABLE played_with (
  user_id TEXT NOT NULL,
  other_id TEXT NOT NULL,
  last_played_on TEXT NOT NULL,   -- ISO, like matches.updated_on
  games INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, other_id)
);
CREATE INDEX played_with_recent ON played_with (user_id, last_played_on);

-- One-way friends: user_id starred friend_id.
CREATE TABLE friends (
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  created_on TEXT NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE invites (
  match_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  created_on TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, to_id)
);
CREATE INDEX invites_to ON invites (to_id, created_on);

CREATE INDEX users_display_name ON users (display_name COLLATE NOCASE);
```

The backfill (same migration) inserts every ordered pair of distinct human players sharing a
`match_players` match whose `matches.player_count = 4`, with `last_played_on = MAX(updated_on)` and
`games = COUNT(*)` per pair. Bot ids (`bot-%`) are excluded in SQL.

## Worker

### Recording who played with whom

`src/people/playedWith.ts` exports `recordPlayedWith(db, playerIds, newcomers?, now)`: for every
ordered pair of distinct humans it upserts
`ON CONFLICT DO UPDATE SET last_played_on = excluded.last_played_on, games = games + 1`, as one
`db.batch`. With `newcomers`, only pairs involving a newcomer are written.

It's called from `MatchDO.publish`, under `bestEffort`, on the same transitions `pushNotices`
already recognises as a start (`push/notices.ts`):

- **the first hand was just dealt** (`justDealt`) — the table filled, or a rematch arrived dealt;
- **a seat taken over in a game under way** — only the newcomer's pairs.

The check is `startedPlayers(previous, next)` in `people/playedWith.ts`, using `hasBeenDealt`
(true from the first deal on), not notices.ts's `isDealt`, which is about the current hand. vs Bots
games have a single human, so write nothing.

### Invite cleanup

Invites go stale, and are deleted, when:

- the invitee takes a seat — `syncMatchPlayers` (`lobby.ts`) adds
  `DELETE FROM invites WHERE match_id = ? AND to_id IN (seated…)` to its batch;
- the table fills (4 seated) — the same batch deletes all of that match's invites;
- the match is deleted — `deleteFromLobbyIndex` deletes its invites.

`GET /api/invites` also filters out invites whose match is no longer `active` with fewer than 4
players, so a missed cleanup never shows a dead invite.

### Routes

New router `src/routes/people.ts`, mounted at `/api/people`; invite routes go in
`routes/matches.ts` (`/:id/invites`) and a small `routes/invites.ts` mounted at `/api/invites`.
All require auth (`userId = c.get('user').sub`) and refuse with `{ title, detail }`.

| Route | Does |
|---|---|
| `GET /api/people` | Friends (newest first), then recent players not already friends (by `last_played_on`, at most 30). Each is a `Person`. |
| `GET /api/people/search?q=` | Prefix match on `users.display_name` (case-insensitive), `q` trimmed, 2–40 chars, at most 20 results, excludes the caller. 400 otherwise. |
| `PUT /api/people/friends/:userId` | Star. 400 for yourself or a bot id; 404 if the user isn't in `users`. Idempotent. |
| `DELETE /api/people/friends/:userId` | Unstar. Idempotent. |
| `POST /api/matches/:id/invites` | Body `{ userIds: string[] }` (1–6, validated like `readUserIds`). Caller must be seated (403); match must be `custom`, not finished, with an open seat (409). Skips seated players, bots and anyone already invited to this table. 409 if the table would pass 6 invites. Stores the rest, pushes them, returns `{ invited: string[] }`. |
| `GET /api/invites` | The caller's undismissed, still-live invites, newest first: `{ matchId, from: PublicUser, createdOn, seatsOpen }[]`. |
| `DELETE /api/invites/:matchId` | Dismiss (sets `dismissed = 1`, so the inviter can't re-send). |

`Person` (in `packages/api-types`): `PublicUser & { isFriend: boolean; lastPlayedOn: string | null;
games: number }`. Names and pictures come from `publicUsers` as `/api/users/search` does; people
`users` doesn't know yet (a backfilled pair never seen since 0007) are looked up through Auth0 the
same way, and dropped from the list if that fails rather than failing the request.

### Push

- `NoticeKind` gains `'invite'`.
- `push/send.ts` gains `sendInvites(env, matchId, from: PublicUser, toIds)`: looks up tokens with
  `tokensFor`, builds a message titled `"{name} invited you to a game"`, body
  `"Tap to pick a seat"`, `data.url = /match/{id}`, `collapseId`/`tag` `invite-{id}`, channel
  `game`, TTL 1 hour, no category buttons - so it's drawn the same on every device (only notices
  with buttons go headless to `drawsOwn` devices). Reuses the existing batching and `DeviceNotRegistered` cleanup.
- Sent with `ctx.executionCtx.waitUntil` so the route doesn't wait on Expo.

## Client package

`packages/client/src/api.ts`: `getPeople`, `searchPeople(q)`, `addFriend(id)`,
`removeFriend(id)`, `invitePlayers(matchId, userIds)`, `getInvites()`, `dismissInvite(matchId)`.

## Web

- **Lobby (`pages/Lobby.tsx`)**
  - An **Invited to** card above the tabs when `getInvites()` returns anything: "{name} invited
    you · {n} seats open", with **Join** (goes to `/match/:id`, where the seat picker shows) and
    **Dismiss**.
  - A third tab, **People**, after Active and Game History: a search box, then the list. Each row
    shows picture, name, "Played 3 games · 2 days ago" (or "Friend"), and a ☆/★ toggle. Typing ≥2
    characters swaps the list for search results (debounced 300 ms). Empty state: "Play a game and
    the people you play with show up here."
- **Match page**: for a `custom` match with open seats, an **Invite players** button beside the
  existing share-link Invite opens a dialog with the same list and search; each row has **Invite**,
  which becomes **Invited ✓**. Players already seated are hidden.
- Shared pieces live in `src/people/` (`PeopleList`, `usePeople`, `useInvites`).

## Mobile

- **Lobby (`app/index.tsx`)**: the same **Invited to** card above the segmented control, and a
  third segment, **People**, with the same list and search.
- **Match screen**: the same **Invite players** button opening a bottom sheet (like
  `NewMatchSheet`).
- Tapping an invite push routes through the existing `notificationRoute` (`data.url`) — no new
  routing.
- Shared pieces in `src/people/`.

## Errors

- `recordPlayedWith` and the invite cleanup run under `bestEffort`: a D1 failure logs and never
  breaks a play.
- A failed push doesn't fail the invite — it's stored and shows in the Lobby.
- Clients show the `{ title, detail }` of a refusal (e.g. "Table is full").

## Testing

- **Worker** (`apps/worker/test/`):
  - `people.playedWith.test.ts` — pairs written on start, rematch and takeover (newcomer only);
    `games` increments; bots skipped; vs Bots writes nothing.
  - `routes.people.test.ts` — list order (friends first, no duplicates), search rules, friend
    star/unstar, refusals.
  - `routes.invites.test.ts` — who may invite, mode/full/finished refusals, skip rules, the
    6-per-table limit, dismiss, cleanup on seat taken / table full / match deleted, stale filter.
  - `push.send.test.ts` — the invite message shape.
  - The migration's backfill against seeded `match_players`.
- **Web**: `Lobby.test.tsx` (Invited to card, People tab), a test for the Invite players dialog.
- **Mobile**: `__tests__` for the People segment and the Invite sheet.

## Out of scope

- Invite-only / private tables and reserved seats (#84).
- Mutual friends, friend requests, blocking.
- Web push.
- Inviting from the Lobby without a table.
