# ML Bots Stage 4, Milestone 2: Hints in Practice Matches — Design

Issue: #76. Milestone 1 (ML bots fill seats, `docs/superpowers/specs/2026-10-05-ml-bots-stage4-design.md`) shipped in #79. Practice matches (the `bots` mode, one human against three bots) shipped in #143.

A player in a practice match can ask the ML bot what it would do in their seat: which bid, which trump, or which domino. The answer comes with a short "why", so hints serve both learning and casual help.

## Decisions

| Question | Decision |
|---|---|
| Who and where | **Practice matches only** (mode `bots`). There is no other human at the table, so fairness, limits and "can others see hints are on" don't arise. |
| How it's asked for | **On demand.** A Hint button on your turn. Nothing is computed until you ask. |
| How much it shows | **The answer plus a short why:** the suggestion, up to 3 bid or trump options with P(make), or each legal domino rated best / close / weaker. |
| Cold start | **Warm up across retries.** Each hint call does at most one piece of model loading. The client retries every **400 ms**. |
| Privacy | Computed in the match's Durable Object, from the caller's own hand and public play only, and proven by a test. |

## Non-goals

- Hints in custom, live or async matches, even with bots seated.
- An always-on hint mode or auto-play.
- The full P(make) table or raw Q-values in the UI.
- Hints after the hand is decided, or for the ready-up step.
- Falling back to the simple bot for hints. If the model is unavailable, so are hints.
- Counting hinted games separately in stats. Practice games are already under "With bots".

## 1. `@fortytwo/bot`: `explain`

**The function.** A new module, `packages/bot/src/explain.ts`, adds:

```ts
type Hint =
  | { kind: 'bid'; suggestion: BidSuggestion; options: BidSuggestion[] }
  | { kind: 'trump'; suggestion: TrumpSuggestion; options: TrumpSuggestion[] }
  | { kind: 'play'; dominoes: PlayRating[] };

interface BidSuggestion { bid: Bid; trump: Suit | null; pMake: number | null }   // Pass: trump and pMake null
interface TrumpSuggestion { trump: Suit; pMake: number }
interface PlayRating { domino: Domino; marks: number; gap: number; rating: 'best' | 'close' | 'weaker' }

// a new method on the existing Bot interface
explain(match: MatchState, playerId: string): Hint
```

**The suggestion is always the bot's own decision.** A new `createDecider(weights)` (`decisions.ts`) holds the bid, trump and play decisions, each returning the decision and the numbers behind it. `createBot` is rebuilt on it: `decideBid`/`decideTrump`/`decideDomino` return just the decision, and the new `Bot.explain` returns both. A hint therefore can never disagree with what a bot in your seat would do, and the parity fixtures keep covering the decision path.

**Bid options.** For each legal non-pass bid, `explain` takes the best-trump option (the same per-bid best that `chooseBid` uses). It shows the suggested bid plus its neighbours in bid order, 3 rows in all: the bid below and the bid above, or the nearest two when the suggestion is at an end. When the suggestion is Pass, the rows are the 3 lowest legal bids, each with its P(make), so the player can see why the bot passed.

**Trump options.** These are the legal trumps at the winning bid, sorted by P(make), top 3; the suggestion is the first. On a partner's plunge, the 42-level P(make) (`table.high`) is used, as `decideTrump` does.

**Play ratings.** Every legal domino is scored with `scoreCandidates`: expected hand marks for the player's team. Ratings are sorted best first. `gap` = best − own score. A domino is rated `best` at gap 0 (ties included), `close` below 0.1, and `weaker` from 0.1 up. With one legal domino, it is `best`, with `marks` and `gap` 0 and no inference.

**Refusals.** `explain` throws a `ValidationError` when it isn't the player's turn to bid, name trump or play, or when the hand is already decided (`gameWinningTeam(game) !== null`).

## 2. Worker: route and `MatchDO.hint`

**Route.** `GET /api/matches/:id/games/current/hint` (`routes/matches.ts`) calls `MatchDO.hint(user.sub)` and replies with the `MatchResult` like the other routes.

**`MatchDO.hint(playerId)`** is a `read`, so it never saves or broadcasts. Steps:
1. Refuse (400) when:
   - the match mode isn't `bots` ("Hints are only available in practice matches");
   - the house rules aren't the defaults (a guard for practice ever gaining house rules);
   - the caller isn't seated;
   - bots are disabled (`BOTS_ENABLED=false`).
2. `await getMlBot(this.env)`:
   - `WARMING` replies `{ status: 'warming' }`;
   - `null` replies `{ status: 'unavailable' }`.
3. Otherwise, reply `{ status: 'ready', hint: explain(match, playerId) }`. A `ValidationError` from `explain` (not your turn, hand decided) is a 400.

**The loader.** `mlBot.ts` is unchanged: it caches the loaded `Bot`, which now has `explain`, so hints and bot moves share one load and one warm-up. `getMlBot`'s one-piece-per-call behaviour is unchanged. A cold hint call does one piece and replies `warming`, as a cold alarm does today.

**Concurrency.** As with bot moves, `getMlBot` runs before the match is read, because its ASSETS fetches don't hold input gates.

**Types.** `HintResponse` (`{ status: 'warming' } | { status: 'unavailable' } | { status: 'ready'; hint: Hint }`) and the `Hint` types are declared once, in `@fortytwo/api-types`. That package is types-only with no dependencies, so bids, suits and dominoes are written there as the plain JSON values the rules engine sends (numbers, and a domino's `{ id, top, bottom }` shape). `@fortytwo/bot` adds `@fortytwo/api-types` as a type-only dependency, and `explain.ts` returns its `Hint`. The web and mobile apps already import from `@fortytwo/api-types`.

## 3. Client: `@fortytwo/client`

**`fetchHint(api, matchId, { signal })`** does the following:
- calls the route;
- on `warming`, waits 400 ms and calls again;
- resolves with the `Hint`, or rejects with "Hints aren't available right now" on `unavailable` or after 10 s of warming;
- stops when `signal` aborts.

A fully cold model takes about 7 calls (1 load, 5 warm-up steps, then the answer), about 3 s. A warm one takes 1 call.

**Keying a hint to its turn.** `hintTurnKey(match)` is `game id : current player : updatedOn`, so any change to the match starts a new turn. A hint belongs to the turn it was asked on.

## 4. Web and mobile UI

The two apps work the same way. Each has a `useHint(matchId, view)` hook over `fetchHint`:
- It holds `idle | loading | ready(hint) | error(message)` for the current turn key.
- Asking again on the same turn reuses the answer.
- When the turn key changes, the state goes back to `idle` and any request in flight is aborted.

**The Hint button** shows only when all of these hold:
- the match mode is `bots`;
- the client config has bots on;
- it is your turn to bid, name trump or play;
- the hand isn't decided;
- no pre-play is queued (both apps have double-click/double-tap pre-play).

It sits with the bidding panel, the trump picker, or the hand:
- web: `apps/web/src/pages/Match.tsx`, near `BiddingPanel`/`TrumpPicker`/`Hand`;
- mobile: `apps/mobile/src/app/match/[id].tsx`, at the same three spots.

**The hint card** (a new `HintCard` component in each app):
- **Loading:** "Thinking…".
- **Bid:** the first line is "Bid 34 · sixes — 68% to make" (or "Pass"), then up to 3 option rows ("30 · sixes 81%"), with the suggested row marked.
- **Trump:** "Sixes — 68% to make", then up to 3 trump rows.
- **Play:** the top 3 legal dominoes, best first: "best", "close (−0.05 marks)", "weaker (−0.40 marks)". Three rows keep the hand in view on a phone; every best domino is also ringed in the hand. The Worker still rates every legal domino.
- **Error:** the message on one line.

**Marking the suggestion in the controls:**
- **Bid or trump:** the suggested button in `BiddingPanel`/`TrumpPicker` gets an outline, through a new optional `suggested` prop.
- **Play:** the best domino in `Hand` gets a badge or glow, through a new optional `suggested` prop. Ties mark every `best` domino.

A hint never acts for the player.

## 5. Tests

- **`@fortytwo/bot`:**
  - **Agreement:** across the fixture hands, at every decision, `explain`'s suggestion equals `decideBid`/`decideTrump`/`decideDomino`.
  - **Privacy:** two matches that differ only in the other three hands (same public play) give identical hints, for a bid, a trump and a play.
  - **Bid options:** 3 neighbouring rows, end cases, and the Pass case.
  - **Trump options:** sorted, top 3, and a partner's plunge.
  - **Play ratings:** sorted, the 0.1 cut-off, ties, and a single legal domino.
  - **Refusals:** not your turn, and hand decided.
- **Worker** (`apps/worker`, vitest-pool-workers, tiny fixture weights):
  - a ready hint in a bots match;
  - 400 for a custom or live match, a non-seated caller, and not your turn;
  - `warming` while loading, then `ready`;
  - `unavailable` when the model fails to load;
  - bots disabled;
  - a hint changes nothing: no save, no broadcast.
- **`@fortytwo/client`:** `fetchHint` retries at 400 ms, resolves, gives up after 10 s, rejects on `unavailable`, and honours abort. `hintTurnKey` changes on every bid, trump call and play.
- **Web and mobile:**
  - the button shows and hides by the rules above;
  - the card renders for each kind and for loading and error;
  - the suggestion is marked in the controls;
  - the state resets when the turn moves on.
- **Seen working:** a practice match in the Android emulator (mobile-emulator skill). Ask for a bid hint, a trump hint and a play hint, and screenshot each.

## 6. Rollout

- No migration and no new configuration. `BOTS_ENABLED=false` turns hints off along with bots.
- After deploy, watch the Worker logs for hint 5xx errors and for cold `warming` runs that end in `unavailable`.
- If #75 (self-play bidding) ships a new bidder, bid hints follow it automatically, because they share the decision code.
