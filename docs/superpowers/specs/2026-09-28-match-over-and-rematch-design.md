# Match Over, Rematch, and New-Hand Cue — Design

Tracks [#22](https://github.com/waterfausett/FortyTwo.Blazor/issues/22).

## Context

When a match ends, `Match.tsx` shows one line in the hand-result panel ("You won the match" /
"They won the match") and nothing else: no recap of the match, no way back to the lobby short of
the nav bar, and no way to play the same four again. The old Blazor app's "next game started" and
"match over" modals were never ported. Separately, a player who readied up and looked away gets no
signal that the next hand was dealt and bidding has started.

## Goals

- A match-over summary: the winner, each team's players and final marks, and every hand played
  (bidder, bid, trump, made or set, marks scored).
- From that summary, go back to the lobby or vote for a rematch.
- A rematch keeps all four seats. It is created only once every human at the table has voted for
  it (bots count as agreeing), and everyone is taken to it automatically.
- A brief toast when a new hand is dealt.

## Non-goals

- Turn notifications, sounds, or focus-aware alerts — [#2](https://github.com/waterfausett/FortyTwo.Blazor/issues/2).
  The new-hand toast goes through a small helper that #2 can grow, but this work adds nothing
  beyond the toast.
- Withdrawing a rematch vote, or a timeout on votes. A player who doesn't want a rematch simply
  doesn't vote; the others can leave via "Back to lobby".
- Linking matches into a series or carrying scores across a rematch. A rematch is a fresh match.

## Rules engine (`packages/rules`)

`MatchState` gains two optional fields, optional so matches already in Durable Object storage
still load:

```ts
rematchVotes?: string[]; // player ids that voted, in vote order
rematchId?: string;      // the rematch's match id, once it exists
```

New functions in `matchEngine.ts`:

- `voteRematch(match, playerId): MatchState` — throws `ValidationError` unless the match is over
  (`winningTeam != null`) and `playerId` is seated. Voting again returns the match unchanged.
  Doesn't know about bots.
- `createRematch(id, previous, dealOrder): MatchState` — a new match with id `id`, the same four
  players at the same positions, all `ready: false`, and the first hand ("Game 1") dealt from
  `dealOrder`. The first bidder (`firstActionBy`/`currentPlayerId`) is the seat after the previous
  match's last hand's `firstActionBy`, so the deal keeps rotating across the rematch. Throws
  unless `previous` has four players.

Both are pure and unit-tested like the existing engine functions.

## Worker (`apps/worker`)

### The old match's Durable Object runs the rematch

The old match's DO owns the whole flow so the new match always exists before any client hears
its id — clients navigate on the broadcast, and must never land on a 404.

New `rematch` RPC on `MatchDO`, `{ playerId }`:

1. `voteRematch(existing, playerId)`.
2. If every seated non-bot player (`isBot`, bots.ts) has voted:
   - If there's no `rematchId` yet, mint one (`crypto.randomUUID()`) and save it with the votes
     before anything else, so a second vote landing while step 3 is in flight can't mint another.
   - Call the new match's DO (`env.MATCH_DO.idFromName(rematchId)`) with a `createRematch` RPC,
     passing the previous match and a `shuffledDominoOrder()`.
3. Save, broadcast, return the old match.

`createRematch` RPC on the new DO, `{ matchId, previous, dealOrder }`: like `create`, allowed on a
DO with no stored match. If a match is already stored it returns it untouched (idempotent);
otherwise it stores `createRematch(...)`, broadcasts, syncs the D1 lobby index for itself (the
way `alarm()` does, since no route touches this match), and schedules bots.

Because step 2 re-runs `createRematch` whenever a `rematchId` is present, a vote retried after a
failed or interrupted creation finishes the job instead of leaving a dangling id.

### Route

`POST /api/matches/:id/rematch` (no body) → `rematch` RPC with the caller's id → sync the D1
lobby index for the old match → return `matchView` of the old match. 400 (the RPC's
`ValidationError`) if the match isn't over or the caller isn't seated; 404 if there's no match.

## Web (`apps/web`)

### Match-over dialog

A new `MatchSummary` component, rendered by `Match.tsx` as a dialog over the table
(`role="dialog"`, `aria-modal`, labelled by its headline) once the match is over **and** the
deciding trick has finished its hold — the same `showHandOver` timing the hand-result panel uses.

Contents:

- Headline: "You won the match" / "They won the match".
- One line per team: its players' names (Us first) and final marks.
- The hands, in game order (sorted by the number in `game.name`, collected from both teams'
  `match.games` lists): game name, bidder's name, bid (`bidToPrettyString`), trump
  (`suitToPrettyString`), and "Made" or "Set" with the marks it scored (`gameValue`). "Made"
  means the team that took the hand is the bidder's team.
- **Back to lobby**: a link to `/`.
- **Rematch**: votes via `POST .../rematch`. After I've voted it's disabled and reads "Waiting for
  rematch (n of 4)", where n is the humans who have voted plus
  the bots at the table. Disabled while disconnected or pending.
- A close button. Closed, the rail's hand-result area shows one line — the headline plus
  **Match summary** (reopens the dialog) and the same Rematch button — replacing today's
  "You won the match" line.

Everything comes from the `MatchState` already on the page; no new fetch.

### Following a rematch

When the match's `rematchId` becomes set, `Match.tsx` navigates to `/match/<rematchId>`. The
`/match/:matchId` route renders `<Match key={matchId} />` so all per-match state (trick hold,
sweep, `awaitingTurnAdvance`, the new-hand tracker below) starts fresh rather than carrying over.

### New-hand toast

`ui/toast.ts` gains `toastInfo(title, text?)`, the same toast styling as `toastError` with an
info icon. `Match.tsx` keeps the last `currentGame.id` it saw in a ref; when it changes (not on
first load), it fires `toastInfo("Game 4 dealt", "Alice bids first")` using `game.name` and the
first bidder's display name ("You bid first" when it's me). Arriving at a rematch counts as a
change from nothing, so it does not toast — the dialog-to-new-table transition is signal enough.

## Testing

- **Rules:** `voteRematch` rejects an unfinished match and an unseated player, records a vote,
  and ignores a repeat. `createRematch` keeps seats and positions, deals seven to each, resets
  ready, names the game "Game 1", and rotates the first bidder.
- **Worker** (Durable Object tests with real storage):
  - Four humans vote on a finished match → the old match has a `rematchId`, and that match exists
    with the same seats and dealt hands. Three votes → no `rematchId`.
  - Bots count as agreeing: one human + three bots → one vote creates the rematch.
  - A vote before the match is over → 400.
  - A repeat vote after the rematch exists doesn't create or re-deal anything.
  - The new match appears in D1's active list for its players.
- **Web:**
  - The dialog appears once the match is over and lists the hands with made/set and marks.
  - Rematch posts, then shows the vote count; it's disabled after voting.
  - Closing the dialog leaves the rail line; "Match summary" reopens it.
  - A broadcast carrying `rematchId` navigates to the new match.
  - The toast fires when `currentGame.id` changes, not on first render.
