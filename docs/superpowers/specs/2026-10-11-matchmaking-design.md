# Matchmaking: Live and Daily play from the lobby

Follow-ups: [#123](https://github.com/waterfausett/FortyTwo.Blazor/issues/123) (skill-based
pairing), [#124](https://github.com/waterfausett/FortyTwo.Blazor/issues/124) (queue with a
partner), [#84](https://github.com/waterfausett/FortyTwo.Blazor/issues/84) (private matches),
[#126](https://github.com/waterfausett/FortyTwo.Blazor/issues/126) (players replace bots mid-game).

## Goal

Getting into a game should work like online chess: say what kind of game you want, and the
server finds you a table. Today you either create a match and sit at an empty table, or browse a
Find a Game list that is often empty or stale (it never refreshes on its own).

Success looks like:

- **New match** (web header button, mobile floating button) opens a chooser: **Live**, **Daily**,
  **Challenge friends**.
- **Live** puts you at a table straight away. While it fills, you see how many people are online
  and waiting, and can **Start now with bots** at any time; if nobody does, bots take the empty
  seats after 2½ minutes. A Live game never stalls on a player who walked away.
- The chooser and the Live search screen show how many players are **online**, so you can tell
  whether waiting for people is worth it.
- **Daily** puts you at an open Daily table (or starts one); it waits for real people, and you get
  a push when it fills.
- **Challenge friends** is today's Create match: a table you fill by sharing the invite link.
- Two players who press Live at the same moment land at the same table.
- The lobby keeps its current shape, minus Find a Game: **Active** and **History**. Active rows say
  whose turn it is, with your-turn games first.

## Decisions

- One spec, one PR: worker, web and mobile together.
- Matchmaking assigns you to a real match right away; the waiting happens at that table (approach
  "A" in brainstorming). No queue tickets yet - #123 may need them, and they can replace the
  Matchmaker's internals without changing clients.
- Pairing is first come, first served. No ratings (#123), no partner queueing (#124).
- Bots fill seats in Live only: when a seated player presses **Start now with bots** (the existing
  `POST /api/matches/:id/bots`), or automatically after `LIVE_FILL_MS` = 150 s as a fallback for a
  table nobody is watching. Daily never adds bots. (Brainstorming started at an automatic 45 s;
  with few players that would make nearly every Live game a bot game.)
- Only an **online** count is shown. A "waiting for Live" count was considered and dropped: everyone
  joins the one open Live table and the fourth seat deals, so it could only ever read 0-3.
- Live depends on bots, so with the bots kill switch off (`BOTS_ENABLED` = `'false'`) Live is
  refused (`POST /api/matchmaking` 404s, as `POST /:id/bots` does) and the chooser hides it. Live
  tables that already exist still fill.
- In Live, a turn that waits 60 seconds is played by a bot, and the player stays on autopilot
  until they act again or press Resume.
- "Whose turn" is looked up from each match's MatchDO when the Active list loads, not stored in
  D1: no new D1 writes (the lobby index was cut back to save writes, see `lobby.ts`
  `SUMMARY_REFRESH_MS`).

## Out of scope

- Skill-based pairing (#123), partner queueing (#124), making Challenge tables private (#84),
  players taking over a bot's seat mid-game (#126).
- Pushing "someone's looking for a Live game" to other players.
- Turn timers or bot fill for Daily and custom matches. Pokes and the 14-day idle sweep stay as
  they are.
- Changing the History list.

## Design

### Match mode

`MatchState` gains `mode: 'live' | 'daily' | 'custom'`. Matches saved before this change have no
`mode` and read as `custom`; so does everything `POST /api/matches` creates. A rematch keeps its
match's mode.

D1 migration: `ALTER TABLE matches ADD COLUMN mode TEXT` (null reads as `custom`). `syncLobbyIndex`
and `refreshMatchSummary` write it; it never changes after creation, so it adds no writes beyond
the row inserts that already happen.

### Matchmaker Durable Object

A new `Matchmaker` DO (binding `MATCHMAKER`, one instance: `idFromName('global')`, new class in a
`wrangler.toml` DO migration). It stores, per mode, a list of open table ids, oldest first.

`play(playerId, mode)`:

1. **Live only:** if the player already sits at an open Live table in the list, return that match
   (one Live search at a time). Membership is checked by reading the match from its MatchDO.
2. For each open table of that mode the player isn't already at, oldest first: call `takeSeat` on
   its MatchDO at the lowest empty seat (with a shuffled deck, as the join route does). Success
   returns the match; if that took the last seat, the id leaves the list. A refusal (full, dealt,
   deleted) drops the id and moves on.
3. No table took them: create a match of that mode with the player in seat 0, add its id to the
   list, return it.

Calls to `play` run one at a time, through an in-memory promise chain in the Matchmaker. DO input
gates don't hold across the outgoing RPCs to MatchDO, so without it two concurrent plays could
each create a table.

The Matchmaker never hears from matches. A stale id (filled by bots, deleted when its last human
left) is found and dropped by the refusal in step 2. Daily allows several open searches per player.

### Routes

- `POST /api/matchmaking { mode: 'live' | 'daily' }` calls `play`, syncs the lobby index for the
  returned match (seats changed), and replies with the match view - the client goes to
  `/match/:id`.
- Cancelling a search is the existing `DELETE /api/matches/:id/players`.
- `POST /api/matches` is unchanged and creates a `custom` match.
- `GET /api/matches?filter=Joinable` stays for mobile builds already installed, but lists only
  `custom` tables. Current clients stop calling it.

### Lobby lists

- **Active** leaves out Live matches that haven't been dealt (`mode = 'live' AND player_count < 4`):
  those are searches, shown on the match page instead.
- Each Active row gains `turn: { yours: boolean; waitingOn: string[] } | null`. For each row on the
  page the route calls a new `MatchDO.getTurn(viewerId)` in parallel, with a short timeout
  (~500 ms). `waitingOn` holds display names (from the names already looked up for the page): the
  player whose turn it is, or everyone still to ready up between hands, or empty while the table
  is filling. `yours` is whether the viewer is among them. A row whose DO fails or times out gets
  `turn: null` and shows without a turn badge; the list never fails for it.
- Cost: at most 20 DO requests per Active page load and no D1 reads or writes for it.
- Clients sort your-turn rows to the top of the rows loaded so far. Pages still come newest first
  (by `updated_on`), so a your-turn game on a later page appears when that page loads.

### Live timers (MatchDO)

A DO has one alarm, already used to pace bots. It becomes a small scheduler: after every save,
MatchDO sets the alarm to the earliest of the pending deadlines below; `alarm()` handles whatever
is due, then sets it again. Bot pacing behaves as it does today.

- **Bot fill:** a Live match records `searchStartedOn` when created. At
  `searchStartedOn + LIVE_FILL_MS` (150 s), if seats are open, bots fill them (the existing
  `addBots` path, without its seated-requester check); the fourth seat deals as usual. The alarm
  path syncs the lobby index for the seat change.
- **Turn timeout:** in a dealt Live match, when it's a human's turn (bid, trump, play, or readying
  up between hands), the deadline is `updatedOn + LIVE_TURN_MS` (60 s). When it passes, the
  player is added to `match.autopilot` (a list of player ids) and a bot makes the move.
- `findNextBotAction` treats a player on autopilot as a bot, so their later turns go at bot pace.
- Any action from a player on autopilot removes them from it. `PATCH /api/matches/:id/players
  { autopilot: false }` does the same without acting, so a player back at the table can take
  their next turn themselves (the client shows **Resume**).
- Daily and custom matches set no timers.

`LIVE_FILL_MS` and `LIVE_TURN_MS` live in `@fortytwo/rules` so clients count down in step with the
server.

### Presence: online and waiting counts

`POST /api/presence` checks the caller in and answers `{ online: number }`.
Clients call it every 30 s while the lobby or a match is open and in the foreground (TanStack
Query `refetchInterval`, which pauses when the app or tab isn't focused).

The Matchmaker answers it from memory, writing nothing: `online` is the players who checked in
within the last 60 s, from an in-memory `Map<playerId, lastSeen>` pruned on each call. A DO that
receives check-ins every 30 s stays resident; if it is evicted anyway, the count rebuilds within
one interval.

One global DO takes every check-in. That's fine at this scale; sharding is a later concern.

### Notifications

No new notices. A Daily table filling triggers the existing `started` notice (`push/notices.ts`)
to every human not watching it. A Live search left in the background gets the same notice when
bots fill the table.

### Clients (web and mobile)

- **Lobby:** tabs become Active / History (Find a Game and its seat picker go). Active rows show
  a **Your turn** badge, "Eli's turn", "Ready up", or "Looking for players · 2 of 4" for a Daily
  table that's filling, plus the mode.
- **New match chooser:** web modal from the header button; mobile bottom sheet from the floating
  button. Live and Daily call `POST /api/matchmaking`, then navigate to the match. Challenge
  friends calls `POST /api/matches`, as Create match does now.
- **Chooser:** "N online" under the title, from `POST /api/presence`.
- **Match page, before the deal:**
  - Live: "Finding players… 0:23" counting up from `searchStartedOn`, "N online", **Start now with
    bots** (`POST /api/matches/:id/bots`) and **Cancel search** (leave).
  - Daily: "Looking for players - we'll notify you when the table fills", and **Leave**.
  - Custom: unchanged (seat picker, invite link, add bots).
- **Match page, Live, after the deal:** a countdown on the current player's seat; players on
  autopilot are marked "away"; your own autopilot shows a **Resume** button.

## Testing

- Presence: a check-in counts the caller online; one older than 60 s drops out.
- Matchmaker: joins the oldest open table; creates one when none is open; drops stale ids (full,
  deleted); two concurrent plays end at one table; Live returns an existing search; Daily allows
  several; a player never gets a second seat at the same table.
- MatchDO scheduler: bot fill at LIVE_FILL_MS fills only open seats and deals; cancel before then deletes
  the match and the alarm does nothing; turn timeout puts the player on autopilot and moves;
  acting or Resume clears autopilot; bot pacing unchanged; Daily and custom set no timers.
- Lobby: Active hides undealt Live matches; `turn` filled from `getTurn`; a failing or slow DO gives
  `turn: null`; Joinable lists only custom tables; `mode` written by sync, null reads as custom.
- Web and mobile: chooser options call the right endpoints; your-turn sorting and badges;
  searching header and Cancel; Resume.
