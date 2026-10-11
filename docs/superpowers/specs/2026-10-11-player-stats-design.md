# Player stats on the Profile — design

Issue: #113. Follow-up (other players' stats, caching): filed alongside the PR.

## Goal

A signed-in player sees their own lifetime record in a **Stats** section of the Profile, on web
and mobile: how many games they've played and won, how their bids go, the marks they've taken,
and who they win with most. Numbers must be right, cheap to keep, and a failed write must never
fail a move.

## Decisions (settled with the owner)

- **Counted from launch.** No backfill. A match's stats are written when it completes; if that
  write fails it is logged loudly (`console.error`, distinctive prefix) and not retried. We'll
  watch the logs and add a sweep backstop only if failures show up.
- **Own stats only.** `GET /api/users/stats` returns the caller's. Viewing another player's
  (tap a seat / Game History row) is a follow-up issue, which also notes the per-player totals
  cache below.
- **Bot split as a toggle:** All / Humans only / With bots. "Humans only" = all four seats held
  people; "With bots" = at least one seat held a bot (`isBot`).
- **Approach A:** one D1 row per human per completed match, aggregated at read time.

## Terminology

The UI follows the lobby: a **game** is a whole match (to 7 marks), a **hand** is one deal (the
code's `Game`).

## Stats and definitions

Per filter (all / humansOnly / withBots):

| Stat | Definition |
| --- | --- |
| Played, Won, Lost, Win rate | Completed matches the player was seated in; won = their team is `winningTeam`. Shown under a "Matches" heading so they can't be read as hands. |
| Marks won | Sum of `gameValue` over hands their team won in those matches. |
| Bids won | Hands where the player was `biddingPlayerId` (filed hands only). |
| Made / Set, Made % | Of those, whether the bidder's team won the hand. |
| Average winning bid | Mean of their bid over points bids (30–42) only. Null when none. |
| Bids of 42+ | Share of their winning bids that were a mark or more (42 and up, incl. Plunge), out of bids won; "–" with none. 42 also counts toward the points average. |
| Favorite trump | The trump named most on their winning bids (Follow Me counts; every Low variant is "Low"), shown as e.g. "Sixes, 12 of 41 bids". A tie goes to the higher suit (Low < Follow Me < Blanks … Sixes). Null with no bids won. |
| Best partner | Human partner (never a bot) with the highest win rate over ≥ 3 games together and at least one win; ties → more games, then partner id for stability. Null when none qualifies. Shown with display name and W–L. |

Only filed hands count (`match.games[team]`); a hand still in `currentGame` at match end is
already filed by the time `winningTeam` is set.

The figures are shown in two headed groups: **Matches** (Played, Won, Lost, Win rate, Marks won,
then best partner) and **Bidding** (Bids won, Made, Set, Made rate, Avg. points bid, Bids of 42+,
then favorite trump).

## Architecture

### Rules package — `matchStatsFor(match)`

New `packages/rules/src/stats.ts`, exported from the package index. A pure function:
`matchStatsFor(match: MatchState): PlayerMatchStats[]` — one entry per **human** seated player
(bots get no row), each with `playerId, partnerId, withBots, won, marksWon, bidsWon, bidsMade,
pointsBidTotal, pointsBidCount, marksBids`. Returns `[]` for a match with no `winningTeam`.
Unit-tested in `packages/rules/src/stats.test.ts` against hand-built `MatchState`s (points bid made/set,
marks bid, Plunge, Low, bots seated, partner pairing).

### D1 — migration `0009_player_match_stats.sql`

```sql
CREATE TABLE player_match_stats (
  match_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  with_bots INTEGER NOT NULL,
  won INTEGER NOT NULL,
  marks_won INTEGER NOT NULL,
  bids_won INTEGER NOT NULL,
  bids_made INTEGER NOT NULL,
  points_bid_total INTEGER NOT NULL,
  points_bid_count INTEGER NOT NULL,
  marks_bids INTEGER NOT NULL,
  trump_low INTEGER NOT NULL,       -- one count column per trump key:
  trump_follow_me INTEGER NOT NULL, -- low, follow_me, blanks, aces, deuces,
  -- ... trump_blanks through trump_sixes  threes, fours, fives, sixes
  completed_on TEXT NOT NULL,
  PRIMARY KEY (match_id, player_id)
);
CREATE INDEX idx_player_match_stats_player ON player_match_stats(player_id);
```

No FK to `matches`: stats outlive lobby rows. Up to 4 rows written per completed match.

### Worker

- `src/stats.ts`:
  - `recordMatchStats(db, match)`: one `db.batch` of `INSERT OR IGNORE` rows from
    `matchStatsFor` (idempotent on retry). Skips when there are no rows.
  - `readPlayerStats(env, playerId): Promise<PlayerStats>`: two queries over the player's rows —
    totals `GROUP BY with_bots`, best partner `GROUP BY partner_id, with_bots` with
    `COUNT(*) >= 3` applied per filter in code (All sums both groups). Partner name via existing
    `publicUsers` (users table cache). About 2N rows read for N completed games.
- `MatchDO`: in `update` and `alarm`, when `previous.winningTeam === null && next.winningTeam !==
  null`, call `recordStats(next)`, which wraps `recordMatchStats` in try/catch and on failure
  `console.error('PLAYER STATS WRITE FAILED for match <id>', error)`. Never throws.
- Route `GET /api/users/stats` in `routes/users.ts` → `c.json(await readPlayerStats(...))`.

### API types — `@fortytwo/api-types`

```ts
export interface StatsSummary {
  played: number; won: number; lost: number;
  marksWon: number;
  bidsWon: number; bidsMade: number; bidsSet: number;
  averagePointsBid: number | null;
  marksBids: number;
  favoriteTrump: { trump: TrumpKey; times: number } | null;
  bestPartner: { user: PublicUser; won: number; lost: number } | null;
}
export interface PlayerStats { all: StatsSummary; humansOnly: StatsSummary; withBots: StatsSummary; }
```

Win rate and made % are derived in the UI (avoid division by zero there: show "–").

### Client — `@fortytwo/client`

`getStats(): Promise<PlayerStats>` → `GET /api/users/stats`. Re-export the types.

### Web — `apps/web/src/pages/Profile.tsx`

New `components/PlayerStats.tsx` rendered below the profile form (above Turn alerts): its own
`useQuery(['stats'])`, a three-button segmented toggle, a grid of stat tiles in the existing
domino-hall style, loading / error / empty ("Finish a match to see your stats here.") states.
Tests in `PlayerStats.test.tsx` with the mocked `apiClient` pattern from `Profile.test.tsx`.

### Mobile — `apps/mobile/src/app/profile.tsx`

New `api/useStats.ts` (query `['stats']`, refetched on screen focus, not `staleTime: Infinity`)
and `components/PlayerStats.tsx` rendered as a section under the settings, same toggle and
tiles in RN styles from `theme.ts`, same three states. Tests in
`components/__tests__/playerStats.test.tsx`.

## Error handling

- Stats write failure: logged, move succeeds, match simply isn't counted (accepted for now).
- Stats read failure: the section shows an inline error; the rest of the Profile works.
- A partner whose name can't be looked up: shown via the existing fallback naming, never fails
  the response.

## Testing

- Rules: `matchStatsFor` unit tests.
- Worker (vitest-pool-workers, real D1 with migrations): `recordMatchStats` + `readPlayerStats`
  aggregation and filters, best-partner threshold/ties; MatchDO writes stats exactly once on the
  completing play (route and bot alarm), not on other moves; a failing DB logs and the move still
  succeeds (`failingDb.ts`); route returns the caller's stats only.
- Web and mobile component tests for the toggle, figures, empty and error states.

## Out of scope

Backfill/sweep, other players' stats, per-player totals cache, per-hand history.
