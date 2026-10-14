# Play vs bots — design

Issue: #111. Bot skill levels (#82) plug in here later.

## Goal

One tap in the New match chooser, on web and mobile, puts a player straight into a game against
three ML bots: the match is created, they're seated, the bots fill the other three seats and the
first hand is dealt — no seat picking, no ready-up. Hidden when bots are off (`BOTS_ENABLED=false`).

## Decisions (settled with the owner)

- **Straight in.** The player always takes seat 0; bots take 1–3. No seat or partner choice.
- **Its own mode, `bots`,** not a Custom Match. The lobby and Game History label it "vs Bots",
  and bot-only rules (skill level, #82) have a mode to hang off.
- **One server route,** not chained client calls: one round trip, and no half-built match
  (you alone at a table) if a step fails.
- **Placement:** a third group in the chooser, **Practice**, below "Play with friends", with one
  option, **Play vs bots** — "Jump straight in against three bots."

## Rules and types

- `MatchMode` gains `'bots'`, in both `packages/rules/src/live.ts` and
  `packages/api-types/src/index.ts`.
- `MODE_LABELS` (`packages/client/src/lobby.ts`) gains `bots: 'vs Bots'`.
- `rematch` already copies `mode`, so a rematch of a bots match is a bots match.

Existing mode checks that already do the right thing for `bots`, unchanged:

- Joinable lists only `custom` matches with open seats (`lobby.ts`) — a bots match never shows.
- The Match page's Invite / Add bots / empty-seat controls show only for `custom`.
- Live-only rules (deadlines, autopilot, claims, the leave-to-bot swap) check for `live`.
- Async's no-bots rule checks for `daily`.
- Stats already record `with_bots`, so these games land in "With bots".
- D1's `matches.mode` is plain `TEXT`: no migration.

## Worker

- `POST /api/matches/bots` (`routes/matches.ts`, registered before `/:id` routes). 404
  `{ title: 'Not found' }` when bots are off, as `POST /:id/bots` does. Mints the match id, calls
  the DO, syncs the lobby index (`bestEffort(syncLobbyIndex)`), replies `201` with
  `matchViewFor(match, userId)` — the same shape as `POST /api/matches`.
- `MatchDO.createVsBots(playerId, matchId)`: builds `createMatch(playerId, 'bots')` with the id,
  runs `seatBots` (the 4th seat deals), saves once, publishes, and schedules — `schedule` sets the
  alarm that starts the bots moving if one of them opens. (`offerIfBotSeated` is Live-only
  matchmaking, not needed here.)
- Leaving: `removePlayer` refuses once the dominoes are dealt, and a bots match is dealt from the
  start, so `MatchDO.leave` gains a case: leaving a bots match that isn't over drops it (`drop`:
  storage and lobby rows go, sockets close with 4404), as leaving a Live game with nobody else
  present does. A finished one is left to the existing path.

## Clients

- `@fortytwo/client`: `playBots()` → `POST /api/matches/bots`, returning the match view.
- Web `NewMatchDialog` and mobile `NewMatchSheet`: `NewMatchChoice` gains `'bots'`; the Practice
  group holds the one option, hidden with Live when bots are off (the existing `liveEnabled`
  flag, renamed only if it reads wrong).
- Web `Lobby` and mobile `index.tsx`: the create mutation sends `'bots'` to `playBots()`, then
  opens the match as it does for the others.
- Match page (web `Match.tsx`, mobile `match/[id].tsx`): the mid-game **Leave game** button,
  today Live-only, shows for bots matches too. Its confirm already reads "Nobody else is
  playing, so it ends." there, since bots never count as present.

## Testing

- Worker: the route returns a dealt match, caller in seat 0, three bots, mode `bots`, and a lobby
  row; 404 with bots off; leaving mid-game deletes the match and its lobby row.
- Web and mobile Match page tests: Leave game shows in a bots match and says the game ends.
- Rules/client: `MODE_LABELS` covers `bots`.
- Web and mobile component tests: the Practice option shows, calls `onChoose('bots')`, and is
  hidden with bots off; the Lobby calls `playBots()`.
- Manual: tap through on web and in the Android emulator.

## Out of scope

- Bot skill level (#82).
- Turning off pokes or pushes for bots matches. With one human, any wait is the player's own
  turn, so there's nobody to poke.
