# Leave game for Custom matches

## Why

Only Live and Bots games can be left once the dominoes are dealt. In a Custom game (friends at a
table they set up), someone who has to drop out has no way out: the match sits until the 14-day
idle sweep deletes it, and the other three lose the game they were playing.

Live solves this by handing the seat to a bot for good. Custom tables are people who chose each
other, so a bot for good is the wrong answer by default: the seat should open up again so the
others can bring someone in, the way they filled the table in the first place.

## Goals

- A seated player can **Leave game** in a dealt Custom match, from the same menu Live and Bots use.
- A bot finishes the hand they left, so the hand under way is never stuck or thrown away.
- At the break the seat shows as **empty**, with the same middle panel as before the deal: "3 of 4
  seated", **Share link**, **Invite players**, and **Fill with bots** (where bots are switched on).
- The next hand isn't dealt until the seat is filled - by a person who sits down, or by a bot the
  others choose to add.

## Non-goals

- Async (`daily`) matches. They only fill with people and haven't been designed for this; leaving
  stays refused after the deal.
- Changing Live or Bots leaving.
- Reserving the open seat for an invitee. Custom invites reserve nothing today (anyone with the
  link can sit), and that stays so (#84 would change it).
- A pause or timeout on the empty seat. It waits as long as the match does; the 14-day idle sweep
  still applies.
- Push notifications about someone leaving or a seat filling.
- Older mobile builds. The only installed app is the owner's, so the worker and clients can ship
  without a release order or flag; an old build at a parked table just shows the bot in the seat
  until it's updated.

## Anti-goals

- A Custom table quietly ending up with a bot for good that nobody asked for. Only a player
  pressing **Fill with bots** puts a bot in the seat for good.
- A hand stalling mid-play because a seat is empty. The seat is only ever open once the hand is
  decided.

## Design

### The parked seat (decided)

The leaver's seat is held by a **parked bot**, not removed. A dealt match keeps four players, so
nothing that assumes "dealt means four seats" (the opener lookup at the break,
`matchEngine.ts:261`; `removePlayer`'s refusal; `seatPlayer` dealing on the 4th hand; the client's
`dealerId` / `trickPlayOrder`) has to learn about a three-player match.

`MatchState` gains `parked?: string[]` - the ids of bots holding a seat for a person. Optional, so
stored matches still read; absent means none.

A parked bot:

- **Until the hand is decided**, plays like any bot (`findNextBotAction`), so the hand finishes.
- **Once the hand is decided** (`gameWinningTeam(currentGame) !== null`), keeps playing out any
  dominoes it still holds when it's its turn, as bots do today (`bots.ts:84-88`), but **never
  readies up**: the "a bot not yet ready readies up" step (`bots.ts:81`) skips parked bots.
- **Is never ready.** Parking sets the seat's `ready: false` (`replaceWithBot` keeps the leaver's
  record, and they may have readied already), and `patchPlayerReady` doesn't deal the next hand
  while any seat is parked - so the table can't deal with a parked bot in it whichever way its
  `ready` flag got set.

### Leaving (`MatchDO.leave`)

In a dealt `custom` match that isn't over:

1. `assertIsMatchPlayer`.
2. If no other **human is seated** (bots and parked bots don't count), drop the match, as Live does
   for the last human present. Custom uses "seated", not "present": friends at a Custom table are
   often not online at the same moment, and one of them leaving shouldn't end the game for the
   others. *(My call.)*
3. Otherwise `replaceWithBot(match, playerId)`, add the new bot id to `parked`, set its `ready:
   false`. Save, publish, schedule (so the bot takes its turn if it's due). The DELETE route syncs
   the lobby row afterwards, as it does for Live.

If they leave once the hand is decided, the seat is open at once.

`DELETE /api/matches/:id/players` is unchanged; the DO decides.

`replaceWithBot` also appends the leaver to `replaced`, which drives Live's "A bot took your seat"
note. For Custom the leaver left on purpose and has navigated away, so the note must not show: the
builder either skips `replaced` for Custom or keys the note on mode. *(Left to the builder.)*

### Open seat

A seat is **open** when it's empty, or held by a parked bot and the current hand is decided
(`gameWinningTeam(currentGame) !== null`). That is the moment the other players see the hand-over
panel and ready up, so it's the break as far as they're concerned. *(My call - the seat opens when
the hand is decided, not when its last domino is down: players often stop playing a decided hand,
so waiting for empty hands could wait for ever.)*

One helper in `@fortytwo/rules` decides this (e.g. `openPositions(match)`), and every check below
uses it in place of `players.length`:

- **Lobby row** (`syncLobbyIndex` / `refreshMatchSummary`): `player_count` counts only seats that
  aren't open, so the table's invites list again (`listInvites` filters `player_count < 4`). It
  also puts the table back in **Joinable**, which only older mobile builds still show.
- **Invites ending** (`syncMatchPlayers`, `lobby.ts:141`): today every invite for a match is
  deleted when `players.length >= 4`. That must count only seats that aren't open, or each seat
  sync at a parked table wipes the invites just sent. Invites deleted when the table first filled
  stay deleted; the players send fresh ones.
- **Sending invites** (`POST /api/matches/:id/invites`, `routes/matches.ts:170`): refuses "Table
  is full" on `players.length >= 4` today; it must allow a table with an open seat.
- **Taking a seat** (see below): `assertNotFull` / `assertSeatOpen` reject a full player list
  before anything could check `parked`.
- **Client views** (`packages/client` `openSeats`, the web and mobile tables, `JoinMatchPanel`,
  `SeatPicker`, the waiting panel's `N of 4 seated`): an open parked seat is drawn and offered as
  an empty seat. The server keeps the parked bot in `players` (so `dealerId`, `trickPlayOrder` and
  the rest still see four seats) and clients check `parked` through the shared helper.
  *(Decided: simplest, since old builds don't need to keep working.)*

**The seat opening must sync the lobby row.** Nobody's seat changes when the hand is decided, so
`syncIfSeatsChanged` won't fire, and the play that decides it may come from a human (through the
routes) or a bot (through the alarm's `refreshMatchSummary`). Wherever a play is saved, a match
whose open seats changed (none before, one now) gets its lobby row synced. *(Where exactly is left
to the builder; it must cover both paths.)*

### Taking the seat

`takeSeat` at an open parked position swaps the person in for the bot - same position, same team,
`ready: true` - and removes the bot from `parked`. This is a new branch, ahead of the full-table
checks. The swap renames the bot's id to the person's everywhere in `currentGame`
(`firstActionBy`, `biddingPlayerId`, `currentPlayerId`, hands, tricks, `currentTrick`), the way
`replaceWithBot` renames the other way. A stale bot id in `firstActionBy` would crash the next deal
(`matchEngine.ts:261`).

If the bot still held dominoes from the decided hand, the newcomer gets them and its turn; they can
play them out or not, like anyone after a hand is decided. *(My call.)*

If everyone else is already ready when they sit, the next hand is **dealt straight away** - only
`patchPlayerReady` deals between hands today, so the sit-down has to run the same deal step, or the
table stalls with four ready players. Otherwise the hand is dealt when the last of the others
readies up, as at any break.

A parked seat whose hand isn't decided yet isn't open, so `takeSeat` refuses it like any taken
seat.

The leaver may come back through the link or an invite like anyone else. *(My call.)*

### Fill with bots

`addBots` at a match with an open parked seat **unparks** it: the bot stays, leaves `parked`, and
readies up on its next action like any bot. It's the same button and the same request as before the
deal, so the existing rules hold: only someone seated may press it, and only where bots are on
(`config.bots`).

### Clients (web and mobile)

- **Leave game** shows for `custom` as well as `live` and `bots`: `canLeaveGame` in
  `apps/mobile/src/app/match/[id].tsx` and the matching check in `apps/web/src/pages/Match.tsx`.
- Confirm text for Custom: "A bot finishes this hand for you, then your seat opens for someone new."
  When nobody else is seated: "Nobody else is at the table, so it ends." *(My wording.)*
- At the break, the middle panel that shows before the deal (`N of 4 seated`, **Share link**,
  **Invite players**, **Fill with bots**) shows whenever the table has an open seat - today it's
  tied to "not dealt yet". The pre-deal **Leave table** / **Cancel match** button stays tied to
  "not dealt"; after the deal, leaving is in the menu.
- The seated players can still ready up while the seat is open, and the hand-over panel makes
  clear the next hand won't be dealt until the seat is filled (e.g. "Waiting for a player"). Exact
  layout is left to the builder.

### Stats *(my call: Live's rules, unchanged)*

`matchStatsFor` already handles a seat changing hands:

- The leaver isn't seated at the end, so gets no row for the match.
- A newcomer's result counts once they've played `MIN_HANDS_FOR_RESULT` (3) hands, or every hand
  of a shorter match.
- `hadBots` is set by `replaceWithBot`, so the match counts as played with bots for everyone.

### Rematch

Someone can leave during the hand that wins the match, so a parked bot can be seated when the
match ends. Once the match is over there's no next hand to hold back, so `parked` is cleared when
the match is won: the bot is an ordinary bot, and rematch counts it as wanting one, as bots always
do. *(My call.)*

## Tests

- Rules: the open-seat helper (parked before the hand is decided is taken; parked after is open;
  plain seats as before); `takeSeat` into an open parked seat renames every id, deals at once when
  the others are ready, and refuses a parked seat whose hand isn't decided; `patchPlayerReady`
  doesn't deal while a seat is parked, even with its `ready` set; `addBots` unparks; `parked`
  cleared when the match is won.
- Worker: `matchDOLeave` - Custom leave mid-hand seats a parked, unready bot that finishes the
  hand and then doesn't ready; a leaver who had readied doesn't leave a ready parked bot; the last
  human seated drops the match; leave after the hand is decided opens the seat at once; lobby
  `player_count` drops to 3 when the hand is decided (both by a human's play and a bot's) and back
  to 4 on sit-down; invites sent at the break survive a seat sync and can be sent at all; Async
  still refuses.
- Bots: a parked bot plays its hand, plays out leftovers after it's decided, and never readies.
- Web and mobile: Leave game shows for Custom; the open-seat panel shows at the break with an open
  seat.

## Left to the builder

- How Custom leaving avoids Live's "replaced" note.
- Where the lobby sync on the seat opening hooks in, as long as both play paths reach it.
- The exact copy and layout of the waiting state at the break.
