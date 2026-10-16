# House rules for custom matches (#117)

## Goal

The creator of a Custom Match picks a few house rules before the table exists. Everyone sees
them in the lobby row and on the match screen. Live, Async and Play vs bots keep today's rules.

## Scope

In:

- **Low (Nello):** off / on (today) / only when the bidder was forced to bid.
- **Plunge:** on (today) / off.
- **When everyone passes:** the last player must bid (today) / reshuffle and redeal.
- **Marks to win:** 1-21, default 7.

Out:

- Sevens and Splash - not supported at all.
- Playing to points (e.g. 250) - its own issue.
- Lay over (#3) - a gameplay feature, not a rule toggle; stays its own issue.
- Editing the rules after the table is created.
- Stats changes: house-rule matches count like any custom match.

## Rules engine (`packages/rules`)

New `houseRules.ts`:

```ts
export interface HouseRules {
  low: 'off' | 'on' | 'forcedOnly';   // default 'on'
  plunge: boolean;                    // default true
  allPass: 'forceLast' | 'redeal';    // default 'forceLast'
  marksToWin: number;                 // default 7, 1-21
}
export const DEFAULT_HOUSE_RULES: HouseRules;
export function houseRules(x: { rules?: Partial<HouseRules> }): HouseRules; // fills in defaults
export function assertValidHouseRules(input: unknown): HouseRules;          // throws ValidationError
```

`assertValidHouseRules` rejects unknown values, a non-integer or out-of-range `marksToWin`, and
`low: 'forcedOnly'` together with `allPass: 'redeal'` (nobody is ever forced under redeal).

Where the rules live:

- `MatchState.rules?` and `Game.rules?`, both optional. Absent means the defaults, so stored
  matches and the other modes behave exactly as today with no migration.
- `createMatch(firstPlayerId, mode, rules?)` sets `match.rules` and the first `Game.rules`.
  Every place that builds a new `Game` copies `match.rules` onto it: `seatPlayer`'s first deal,
  `patchPlayerReady`, `redeal` and `createRematch`. A rematch keeps the rules.
- Functions that only receive a `Game` (`availableBids`, `availableTrumps`, the bot) read
  `game.rules`, so their signatures and callers don't change. Match length is read from
  `match.rules`.

Rule effects:

- `availableBids`: Plunge only when `plunge` is on. Pass is always offered under `redeal`.
- `assertValidBid`: "Everyone can't pass" applies only under `forceLast`.
- `availableTrumps`: Low still needs a bid of at least 42 under every setting - Low is a trump
  choice, never a bid. `off` removes the Low trumps. `forcedOnly` also requires that the other
  three players all passed. `assertValidTrump` gives a reason for each refusal.
- `lowAllowedIfWon(game, playerId)`: whether this player could name Low if their next bid won
  (42+ available to them, the `low` setting, and for `forcedOnly` whether the other three have
  passed). It shares one check with `availableTrumps` so the two can't disagree.
- Redeal: `placeBid` keeps its signature; under `redeal` the fourth pass just records it.
  `needsRedeal(match)` is true when all four hands bid and all passed. `redeal(match, dealOrder)`
  deals new hands to the same seats, clears the bids and keeps `firstActionBy` - the same player
  opens again. No marks are scored and the hand keeps its name. While `needsRedeal` is true,
  `setTrump` and `playDomino` refuse.
- `playDomino` wins the match at `houseRules(match).marksToWin` instead of `WINNING_SCORE`.
  `WINNING_SCORE` stays exported as the default.

## Bots (`packages/bot`)

`optionsFromTable` adds the three Low options to every bid of 42 or more. With Low disallowed
the bot could bid a mark on Low strength and then be refused Low at trump time.

- `optionsFromTable(table, legal, allowLow = true)` leaves out the Low options when false.
- `decideBid` passes `lowAllowedIfWon(game, playerId)`. On default rules this is always true, so
  bidding is unchanged and the Stage 2 measurement still holds. No retraining.
- Plunge off and redeal need nothing: the bot picks only from `availableBids` /
  `availableTrumps`.
- The worker's simple fallback bots bid only when forced and never name Low; under redeal they
  always pass, which is fine.
- The hints work (`ml-hints` worktree) must pass the same flag if it calls `optionsFromTable`.

## Worker and API

- `POST /api/matches` takes an optional body `{ rules?: Partial<HouseRules> }`, validated by
  `assertValidHouseRules` (400 on a bad value). No body means defaults, so installed mobile
  builds keep working. Matchmaking and `/bots` don't take rules.
- `MatchDO.create(firstPlayerId, matchId, mode, rules)` passes them to `createMatch`.
- One helper, `bidAndMaybeRedeal(match, playerId, bid)`: `placeBid`, then
  `redeal(match, shuffledDominoOrder())` only when `needsRedeal`. The bid route
  (`matchDO.ts`) and both bot paths (`bots.ts`) use it. Both steps happen in one update, so the
  all-passed state is never stored or broadcast, and the deck is shuffled only when it's needed.
- The match view already spreads `MatchState`, so `rules` reaches both apps with no new endpoint.
- Lobby: migration `0012_matches_rules.sql` adds nullable `rules TEXT` (JSON) to `matches`,
  written once at creation and only when the rules differ from the defaults. The lobby `SELECT`
  reads it; `MatchSummary` gains `rules?: HouseRules`. Same statements as today, so no extra D1
  reads or writes.
- `client.createMatch(rules?)` in `packages/client/src/api.ts`.

## Web and mobile

- `houseRuleLabels(rules)` in `packages/client`: short labels for non-default settings only -
  `No Low`, `Low only when forced`, `No Plunge`, `Redeal on all pass`, `To 5 marks`. Default
  rules give no labels, so standard tables look as they do today.
- Create flow: in the web `NewMatchDialog` and mobile `NewMatchSheet`, choosing Custom Match
  replaces the option list with a House rules step:
  - Low: Off / On / Only when forced. "Only when forced" is disabled, with a one-line reason,
    while Redeal is selected; picking Redeal moves it to On.
  - Plunge: on/off switch.
  - When everyone passes: Last player must bid / Redeal.
  - Marks to win: - / + stepper, 1-21.
  - Back and Create table. It opens on the defaults. The working and slow-connection text move
    to the Create button.
- Lobby row: labels appended to the existing line, e.g.
  `Custom · Low only when forced · To 5 marks · 2m ago`.
- Match screen: a "House rules" line under the score with the same labels, only when there are
  any. `packages/client/src/matchView.ts` uses `marksToWin` where it assumes 7.
- Trump picker and bidding panel: unchanged - they render `availableTrumps` / `availableBids`.
- How to play: unchanged (generic). Match-specific rules are on the match screen.

## Testing

- Rules: each setting on and off; `forcedOnly` Low allowed only after three passes and still
  only at 42+; redeal keeps the opener and deals new hands; `setTrump`/`playDomino` refuse while
  a redeal is due; match won at `marksToWin`; a rematch keeps the rules; a match stored without
  `rules` behaves exactly as today; `assertValidHouseRules` rejects bad input and
  forcedOnly + redeal.
- Bot: a hand strong only for Low doesn't bid 42+ with `low: 'off'`; default-rules bidding is
  unchanged.
- Worker: create with and without rules, 400 on bad rules, other modes ignore rules, a fourth
  pass under redeal broadcasts a fresh deal with the same opener, the lobby row carries rules.
- Web and mobile: the House rules step (defaults, the forcedOnly/redeal interplay, Back,
  Create sends the rules), lobby row labels, match screen line.
