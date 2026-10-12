# Matchmaking: Over the table and Daily play from the lobby

Follow-ups: [#123](https://github.com/waterfausett/FortyTwo.Blazor/issues/123) (skill-based
pairing), [#124](https://github.com/waterfausett/FortyTwo.Blazor/issues/124) (queue with a
partner), [#84](https://github.com/waterfausett/FortyTwo.Blazor/issues/84) (private matches).
Players replacing bots mid-game ([#126](https://github.com/waterfausett/FortyTwo.Blazor/issues/126))
is part of this spec: see **Seat takeover**.

## Goal

Getting into a game should work like online chess: say what kind of game you want, and the
server finds you a table. Today you either create a match and sit at an empty table, or browse a
Find a Game list that is often empty or stale (it never refreshes on its own).

Success looks like:

- **New match** (web header button, mobile floating button) opens a chooser in two groups:
  **Find opponents** (people icon: **Over the table**, **Daily** - both matchmade) and **Play with
  friends** (**Challenge friends**).
- **Over the table** puts you at a table straight away. While it fills, you see how many people are
  online, and can **Start now with bots** at any time; if nobody does, bots take the empty seats
  after 2½ minutes. A game never stalls on a player who walked away.
- Players who come along later take over bot seats between hands, so tables fill up with people
  over time. Someone waiting for a seat watches the hand in progress.
- A game with no human left at the table is dropped, rather than played out bot against bot.
- The chooser and the search screen say plainly how the mode works.
- With the presence flag on, the chooser and the search screen show how many players are
  **online**, so you can tell whether waiting for people is worth it.
- A player is in at most one Over the table match at a time - searching, waiting for a seat or
  playing: pressing Over the table again takes them back to it.
- **Daily** puts you at an open Daily table (or starts one); it waits for real people, and you get
  a push when it fills.
- **Challenge friends** is today's Create match: a table you fill by sharing the invite link.
- Two players who press Over the table at the same moment land at the same table.
- The lobby keeps its current shape, minus Find a Game: **Active** and **History**. Active rows say
  whose turn it is, with your-turn games first.

## Decisions

- One spec, one PR: worker, web and mobile together, seat takeover included.
- **Naming:** "Over the table" is display text only. In code, storage, D1 and the API the mode stays
  `'live'` (`mode: 'live'`, `POST /api/matchmaking { mode: 'live' }`, `LIVE_*` constants), so stored
  matches and installed mobile builds keep working. This spec says "Over the table" for the
  player-facing mode and `live` for the value.
- Matchmaking assigns you to a real match right away; the waiting happens at that table (approach
  "A" in brainstorming). No queue tickets yet - #123 may need them, and they can replace the
  Matchmaker's internals without changing clients.
- Pairing is first come, first served. No ratings (#123), no partner queueing (#124).
- Bots fill seats in Over the table only: when a seated player presses **Start now with bots** (the
  existing `POST /api/matches/:id/bots`), or automatically after `LIVE_FILL_MS` = 150 s as a
  fallback for a table nobody is watching. Daily never adds bots. (Brainstorming started at an
  automatic 45 s; with few players that would make nearly every game a bot game.)
- Only an **online** count is shown. A "waiting" count was considered and dropped: everyone joins
  the one open table and the fourth seat deals, so it could only ever read 0-3.
- Over the table depends on bots, so with the bots kill switch off (`BOTS_ENABLED` = `'false'`) it
  is refused (`POST /api/matchmaking` 404s, as `POST /:id/bots` does) and the chooser hides it.
  Tables that already exist still fill.
- In Over the table, a turn that waits 60 seconds is played by a bot, and the player stays on
  autopilot until they act again or press Resume - unless they are the last human present: then
  the table **pauses** instead, so bots never play a table with nobody at it (no paying for
  bot-only cycles), and it's dropped if they don't come back.
- "Whose turn" is looked up from each match's MatchDO when the Active list loads, not stored in
  D1: no new D1 writes (the lobby index was cut back to save writes, see `lobby.ts`
  `SUMMARY_REFRESH_MS`).
- **Seat takeover happens at the hand break, never mid-hand**: a joiner shouldn't inherit a bid and
  dominoes they didn't choose. Until then they hold a **claim** and watch.
- **Humans who stay play; anyone who stops is replaced by a bot; bots are replaced by humans.** A
  player away (on autopilot) for a whole hand is replaced by a bot at the break, as is a player
  who presses Leave game (at once). **Claims only ever take bot seats**, so at most as many claims
  as bot seats, and a returning player never races a claimant. (Brainstorming first had claims
  take away players' seats directly; replacing them with bots first removed open-seat tracking and
  the Resume-versus-claim race.)
- The cost: a player away for a whole hand - several timed-out turns, typically 3+ minutes -
  loses their seat even when nobody is waiting for it.
- **No joining near the end**: claims are refused once either team has 5 marks (of 7).
- A claimant who loses out (the match ends or is dropped before a seat comes up) is sent searching
  again automatically.
- Late joiners' stats count, as a bots game. A match result counts only for a player who played
  at least 3 hands; bids always count. Hands the bot bid for a player on autopilot count for
  neither. Replaced players get no stats row (bids included) - revisit if that feels wrong.
- The Matchmaker keeps `live` tables on its list after the deal; MatchDO also offers itself (RPC,
  fire and forget) **whenever a bot takes a seat**, so a table that gains a bot seat after being
  dropped from the list is found again.

## Out of scope

- Skill-based pairing (#123), partner queueing (#124), making Challenge tables private (#84).
- Pushing "someone's looking for a game" to other players.
- Turn timers, bot fill or seat takeover for Daily and custom matches. Pokes and the 14-day idle
  sweep stay as they are.
- Stats for a replaced player (their bids before leaving are not recorded).
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
`wrangler.toml` DO migration). It stores, per mode, a list of table ids, oldest first: tables still
filling and, for `live`, games under way that may have a seat to claim.

`play(playerId, mode)`:

1. **`live` only:** if the player already sits at, or holds a claim at, a table in the list, return
   that match (one game at a time). Membership is checked by reading the match from its MatchDO.
2. For each table of that mode **still filling** (under four, not dealt) that the player isn't
   already at, oldest first: call `takeSeat` on its MatchDO at the lowest empty seat (with a
   shuffled deck, as the join route does). Success returns the match; if that took the last seat
   of a Daily table, the id leaves the list. A refusal moves on: a deleted table's id is dropped,
   and so is a full Daily one (a full `live` table has dealt and is tried in step 3).
3. **`live` only:** for each **dealt** table, oldest first: call `claimSeat` on its MatchDO. Success
   returns the match. A refusal (finished, 5 marks, no unclaimed bot seat, deleted) drops the id.
4. No table took them: create a match of that mode with the player in seat 0, add its id to the
   list, return it.

A `live` table that deals keeps its place in the list: its seats may yet go to bots and then to
claims. It leaves when a claim is refused.

`offer(matchId)` adds a `live` id to the list if it isn't there. MatchDO calls it whenever a bot
takes a seat (see **Seat takeover**), so a table dropped from the list is found again once it has
a seat to claim.

Calls to `play` and `offer` run one at a time, through an in-memory promise chain in the
Matchmaker. DO input gates don't hold across the outgoing RPCs to MatchDO, so without it two
concurrent plays could each create a table, or an offer could be lost under a play's write.

A stale id (deleted, finished) is found and dropped by the refusal in steps 2-3. Daily allows
several open searches per player.

### Routes

- `POST /api/matchmaking { mode: 'live' | 'daily' }` calls `play`, syncs the lobby index for the
  returned match (seats changed), and replies with the match view - the client goes to
  `/match/:id`. The player may be seated there or holding a claim.
- `DELETE /api/matches/:id/players`:
  - before the deal: leaves the table, as today (Cancel search);
  - holding a claim: releases it (Cancel);
  - seated at a dealt `live` match: **Leave game** (see **Leaving and dropped matches**);
  - otherwise refused after the deal, as today.
- `POST /api/matches` is unchanged and creates a `custom` match.
- `GET /api/matches?filter=Joinable` stays for mobile builds already installed, but lists only
  `custom` tables. Current clients stop calling it.

### Lobby lists

- **Active** leaves out `live` matches that haven't been dealt (`mode = 'live' AND player_count < 4`):
  those are searches, shown on the match page instead. A claim isn't a seat, so a claimed match
  isn't in the claimant's Active list until they're seated.
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

- **Bot fill:** a `live` match records `searchStartedOn` when created. At
  `searchStartedOn + LIVE_FILL_MS` (150 s), if seats are open, bots fill them (the existing
  `addBots` path, without its seated-requester check); the fourth seat deals as usual. The alarm
  path syncs the lobby index for the seat change.
- **Turn timeout:** in a dealt `live` match, when it's a human's turn (bid, trump, play, or readying
  up between hands), the deadline is `updatedOn + LIVE_TURN_MS` (60 s). When it passes, the
  player goes on autopilot (`match.autopilot`, plus `awaySince[playerId]` = now) and a bot makes
  the move.
- **Pause and drop:** if the human the table waits on is the **last one present** (every other
  seat is a bot or on autopilot), the timeout doesn't put them on autopilot. The table pauses -
  nobody moves, so no bot cycles are spent - and `liveDeadline` gives `kind: 'drop'` at
  `updatedOn + LIVE_TURN_MS + LIVE_ABANDON_MS` (120 s) in place of `kind: 'turn'`. If they act
  before then (their clock shows overdue) play carries on; no Resume is needed, as they were never
  on autopilot. If not, the match is dropped (see **Leaving and dropped matches**). When several
  humans wait at once (readying up), the table pauses only if none of them would be left present.
- `findNextBotAction` treats a player on autopilot as a bot, so their later turns go at bot pace.
- Any action from a player on autopilot takes them off it (clearing `awaySince`). `PATCH
  /api/matches/:id/players { autopilot: false }` does the same without acting, so a player back at
  the table can take their next turn themselves (the client shows **Resume**).
- Daily and custom matches set no timers.

`LIVE_FILL_MS`, `LIVE_TURN_MS` and `LIVE_ABANDON_MS` live in `@fortytwo/rules` so clients count
down in step with the server.

### Seat takeover

Humans who stay play; anyone who stops is replaced by a bot; bots are replaced by humans. Claims
only ever take bot seats.

**New `MatchState` fields** (all optional, so stored matches still read):

- `claims?: string[]` - players waiting for a seat, in claim order.
- `awaySince?: Record<string, string>` - when each player on autopilot went away. Written with
  `autopilot`, cleared with it.
- `Game.dealtOn?: string` - when the hand was dealt, to tell "away for the whole hand".
- `hadBots?: boolean` - set the first time a bot takes a seat; never cleared.
- `replaced?: string[]` - players who lost their seat to a bot, so their client can say why.
- `bumped?: string[]` - claimants released without a seat, so their client searches again.

**Rules actions:**

- `claimSeat(match, playerId)`: allowed when the match is `live`, dealt, not finished, both teams
  are under `TAKEOVER_MAX_MARKS` (5), the player isn't seated or already claiming, and claims are
  fewer than the bot seats.
- `releaseClaim(match, playerId)`.
- `replaceWithBot(match, playerId)`: the seat goes to a free bot id (`BOT_IDS`; with a human still
  seated at most three seats are bots, so one is always free), keeping position, team and the
  current hand; the player goes into `replaced` and out of `players`, `autopilot` and
  `awaySince`. Sets `hadBots`.

**At the hand break** (in `patchPlayerReady`, when everyone is ready), before dealing:

1. Every player **away for the whole hand** (`awaySince` at or before the hand's `dealtOn`) is
   replaced by a bot. The last present human is never on autopilot (see **Pause and drop**), so this
   never leaves a table without a human.
2. Claims take bot seats in claim order, lowest position first. The joiner keeps the seat's
   position, team and team score, and is ready. Claims never outnumber bot seats, so every claim
   is seated.
3. The opener is worked out **by position** from the last hand's opener, not by player id - the
   old lookup of `lastGame.firstActionBy` among `players` would fail if that seat just changed
   hands.

Doing 1 before 2 lets a claimant take an away player's seat at the same break. Filed hands keep
the id of whoever held the seat, so a bot's earlier hands stay the bot's.

**MatchDO:**

- `claimSeat` / `releaseClaim` RPCs wrap the rules actions, save and broadcast.
- At the break, if seats changed hands, the lobby index syncs (a joiner gets an Active row, a
  replaced player loses theirs) and a joiner with no socket open gets the existing `started`
  push.
- **Whenever a bot takes a seat** - bot fill, a player replaced at the break, Leave game, a `live`
  rematch created with bots - MatchDO calls `Matchmaker.offer(matchId)` (`ctx.waitUntil`, fire
  and forget). A lost offer only means a seat isn't found.
- A claimant watches over the match socket. Anyone signed in may already open it and gets the view
  with every hand hidden (`handleWebSocketUpgrade`), so nothing changes there.

### Leaving and dropped matches

You can't leave a dealt match today (`removePlayer` refuses). In `live`, there are two kinds of
leaver:

- **Leave game** (on purpose, `DELETE /api/matches/:id/players` once dealt): `replaceWithBot` at
  once, mid-hand; the bot plays out their hand. If they were the last human present, the match is
  dropped instead.
- **Silent** (app closed, signal lost): autopilot, then replaced by a bot at the break after a
  whole hand away - or, for the last human present, the pause and drop above.

**Dropping** reuses the delete path for "last human left before the deal": close sockets,
`deleteAll`, remove the lobby rows. No stats are written. Claimants are put in `bumped` in the
final broadcast before the sockets close, and their clients search again. A client still on the
match otherwise handles it as it handles any deleted match.

A claimant also lands in `bumped` if the match finishes before the break that would seat them.

### Stats

- `withBots = match.hadBots ?? players.some(isBot)`: a match bots ever sat in counts as a bots game.
- `Hand.autoBid?: true` is set when the bot made that seat's bid or trump call for a player on
  autopilot. MatchDO's bot path passes `{ auto: true }` to `placeBid` / `setTrump` when the seat
  is a player's (`isOnAutopilot`), not a bot's.
- A player **played** a hand if a filed hand has their id and no `autoBid`. Their bidding stats
  (bids won and made, points-bid average, marks bids, trumps) skip `autoBid` hands. A player who
  bids, then goes away for the play, keeps the bid and the hand.
- `matchStatsFor` writes `handsPlayed` on each row. Hands filed before this change have no
  `autoBid` and count as played.
- Rows are still written only for humans seated at the finish: a replaced player gets none, and a
  dropped match gives nobody any.

D1 migration `0011`: `ALTER TABLE player_match_stats ADD COLUMN hands_played INTEGER` (null on
existing rows). A match's **result** counts for a row when `hands_played IS NULL OR hands_played >=
MIN_HANDS_FOR_RESULT` (3, a bound parameter). The totals query gates `played`, `won` and
`marks_won` with `CASE WHEN` in the aggregates and leaves bids and trumps ungated; the best
partner query filters with `WHERE`. Only a joiner can fall short - anyone there from the start
plays at least 7 hands.

### Notifications

No new notices. A Daily table filling triggers the existing `started` notice (`push/notices.ts`)
to every human not watching it. A search left in the background gets the same notice when bots
fill the table, and so does a claimant when they're seated.

### Clients (web and mobile)

- **Naming:** every player-facing "Live" becomes **Over the table**: chooser, lobby mode label,
  search header, toasts, empty-state copy.
- **Lobby:** tabs become Active / History (Find a Game and its seat picker go). Active rows show
  a **Your turn** badge, "Eli's turn", "Ready up", or "Looking for players · 2 of 4" for a Daily
  table that's filling, plus the mode.
- **New match chooser:** web modal from the header button; mobile bottom sheet from the floating
  button. Over the table and Daily call `POST /api/matchmaking`, then navigate to the match.
  Challenge friends calls `POST /api/matches`, as Create match does now. "N online" under the
  title, from the presence socket. The Over the table option reads: "Play now with whoever's
  online. Bots fill empty seats after 2½ min, or start with bots any time. 60-second turns; new
  players take over bots' seats between hands."
- **Match page, before the deal:**
  - Over the table: "Finding players… 0:23" counting up from `searchStartedOn`, "N online", a line
    on how it works ("Bots take the empty seats at 2:30. Players can still join after you
    start."), **Start now with bots** (`POST /api/matches/:id/bots`) and **Cancel search** (leave).
  - Daily: "Looking for players - we'll notify you when the table fills", and **Leave**.
  - Custom: unchanged (seat picker, invite link, add bots).
- **Match page, holding a claim:** the table as any unseated viewer sees it, with the hand area
  replaced by "Joining a game in progress. You'll take a seat when this hand ends." and
  **Cancel**. If the viewer lands in `bumped` (the match ended or was dropped first), the client
  shows "That game ended - finding you another table…", calls `POST /api/matchmaking` itself and
  goes where it lands; if that fails, **Find another**.
- **Match page, Over the table, after the deal:** a countdown on the current player's seat; players
  on autopilot are marked "away"; your own autopilot shows a **Resume** button. A paused table
  shows "Waiting for Sam…" with their clock overdue (they're not on autopilot, so not "away").
  **Leave game** in the match menu, with a confirm ("Leave this game? A bot takes your seat.").
- **Seat changes:** a toast "Bot 2 took Eli's seat" / "Sam took Bot 2's seat", worked out by
  comparing players before and after an update.
- **Replaced:** a viewer in `replaced` sees "A bot took your seat after you were away for a hand"
  and **Back to lobby**.

## Testing

- Presence: a new socket gets the count straight away; a player with two sockets counts once;
  connects within a minute of a broadcast are sent together by one alarm, not one message each.
- Matchmaker: joins the oldest table still filling; creates one when none is open; drops stale ids
  (full, deleted); two concurrent plays end at one table; `live` returns an existing search or
  claim; Daily allows several; a player never gets a second seat at the same table; filling tables
  before games under way before a new table; a refused claim drops the id; `offer` adds an id once
  and doesn't race `play`.
- Rules: `claimSeat` refusals (not `live`, not dealt, finished, 5 marks, seated, already claiming,
  claims as many as bot seats); at the break a player away for the whole hand (against `dealtOn`)
  is replaced by a bot, one who went away mid-hand isn't; claims then take bot seats lowest
  position first, including a seat just given to a bot; the opener is right after a swap;
  `replaceWithBot` picks a free bot id and keeps position, team and hand; `awaySince` set and
  cleared with autopilot; the last present human is never put on autopilot and `liveDeadline`
  gives `drop` at turn + 60 s + 120 s for them; `hadBots` sticks; `autoBid` set only for a player
  on autopilot.
- Stats: `withBots` from `hadBots`; `handsPlayed` skips `autoBid` hands; bidding stats skip them;
  a joiner under 3 hands has bids counted but no result; null `hands_played` counts; partner
  records skip short rows.
- MatchDO scheduler: bot fill at LIVE_FILL_MS fills only open seats and deals; cancel before then
  deletes the match and the alarm does nothing; turn timeout puts the player on autopilot and
  moves; acting or Resume clears autopilot; bot pacing unchanged; Daily and custom set no timers;
  a paused table makes no bot moves; the drop alarm deletes the match, bumps claimants and writes
  no stats; acting before it carries on.
- MatchDO takeover: a claim becomes a seat at the break and the lobby syncs; every bot taking a
  seat (fill, replacement, Leave game, rematch) offers the table; Leave game gives the seat to a
  bot at once, and by the last present human drops the match; a match finishing bumps its
  claimants; a claimant's view hides every hand.
- Lobby: Active hides undealt `live` matches; `turn` filled from `getTurn`; a failing or slow DO
  gives `turn: null`; Joinable lists only custom tables; `mode` written by sync, null reads as
  custom.
- Web and mobile: chooser options call the right endpoints and say Over the table; your-turn
  sorting and badges; searching header and Cancel; Resume; claim banner and Cancel; game ended
  before a seat and Find another; seat-change toast; Leave game confirm; replaced screen.
