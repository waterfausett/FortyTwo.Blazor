# Player Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in player sees their own lifetime stats (games, bidding, marks, best partner; All / Humans only / With bots) in a Stats section of the Profile on web and mobile.

**Architecture:** When a match completes, the MatchDO derives one row per human from the full `MatchState` (pure `matchStatsFor` in `@fortytwo/rules`) and writes them to a new D1 table `player_match_stats` (`INSERT OR IGNORE`, failure logged loudly, never fails the move). `GET /api/users/stats` aggregates the caller's rows into three `StatsSummary`s. A shared formatter in `@fortytwo/client` turns a summary into labelled tiles that the web and mobile `PlayerStats` components render.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects + D1, Hono, vitest (+ `@cloudflare/vitest-plugin`), React + TanStack Query (web, vitest + RTL), React Native/Expo (mobile, jest + RNTL).

**Spec:** `docs/superpowers/specs/2026-10-11-player-stats-design.md`

All paths below are relative to `cloudflare/` unless they start with `docs/`. Run commands from `cloudflare/`.

## Global Constraints

- Counted from launch: no backfill, no sweep.
- Failed stats write: `console.error('PLAYER STATS WRITE FAILED for match <id>', error)`; the move still succeeds.
- Own stats only: `GET /api/users/stats` returns the caller's stats; no route takes another player's id.
- UI terms: a **game** is a whole match; a **hand** is one deal.
- Filters: `all`, `humansOnly` (no seat held a bot), `withBots` (at least one seat held a bot, `isBot`). Labels: "All", "Humans only", "With bots".
- Average winning bid counts points bids (30–42) only; bids of 84 and up (incl. Plunge 169) count as "Marks bids".
- Best partner: human only, at least `BEST_PARTNER_MIN_GAMES = 3` games together, highest win rate; ties → more games, then partner id ascending.
- Bots get no stats rows. D1 writes: at most 4 rows per completed match.
- Empty state copy: "Finish a game to see your stats here."
- Conventional commits; PR title `feat: player stats on the Profile` is not allowed to be scope-less for release-please — use `feat(worker): player stats on the Profile` (worker carries the migration and route; web/mobile ship with it).

## Review Focus

1. A player with zero completed games → every number 0, rates "–", average "–", best partner null; UI shows the empty state, not "NaN%". (Task 2 formatter test, Task 3 read test, Tasks 6–7 UI tests.)
2. Plays after the match is already won (allowed by `playDomino`) must not write again or double-count → only the `null → team` transition records; `INSERT OR IGNORE` backs it up. (Task 4 test.)
3. A partner who is a bot, or a human with fewer than 3 games together, is never best partner. (Task 3 test.)
4. D1 down at match end → the completing play still returns ok and the error is logged with the exact prefix. (Task 4 test.)
5. A best partner whose name can't be found (no `users` row, Auth0 unknown) still yields a response with a fallback name. (Task 3 test.)

---

### Task 1: `matchStatsFor` in the rules package

**Files:**
- Create: `packages/rules/src/stats.ts`
- Create: `packages/rules/src/stats.test.ts`
- Modify: `packages/rules/src/index.ts` (add exports at the end)

**Interfaces:**
- Produces:
  ```ts
  export interface PlayerMatchStats {
    playerId: string; partnerId: string; withBots: boolean; won: boolean;
    marksWon: number; bidsWon: number; bidsMade: number;
    pointsBidTotal: number; pointsBidCount: number; marksBids: number;
  }
  export function matchStatsFor(match: MatchState): PlayerMatchStats[];
  ```

- [ ] **Step 1: Write the failing test** — `packages/rules/src/stats.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { matchStatsFor } from './stats';
import { Bid } from './bid';
import { Suit } from './suit';
import { Teams } from './teams';
import type { Game } from './game';
import type { MatchState } from './matchEngine';
import type { Positions } from './positions';

// A filed hand: who bid what, and the team that took it. Only the fields stats read are real.
function hand(n: number, bidder: string, bidderTeam: Teams, bid: Bid, trump: Suit = Suit.Sixes): Game {
  return {
    id: `g${n}`,
    name: `Game ${n}`,
    firstActionBy: null,
    bid,
    biddingPlayerId: bidder,
    trump,
    currentPlayerId: null,
    hands: [{ playerId: bidder, team: bidderTeam, dominoes: [], bid }],
    currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
    tricks: [],
  };
}

function match(players: string[], games: MatchState['games'], winningTeam: Teams | null): MatchState {
  return {
    id: 'm1',
    createdOn: '2026-10-01T00:00:00.000Z',
    updatedOn: '2026-10-01T01:00:00.000Z',
    winningTeam,
    games,
    players: players.map((playerId, position) => ({ playerId, position: position as Positions, ready: true })),
    currentGame: hand(99, players[0], Teams.TeamA, Bid.Thirty),
  };
}

describe('matchStatsFor', () => {
  // Seats 0 & 2 are TeamA, 1 & 3 TeamB.
  const players = ['p1', 'p2', 'p3', 'p4'];

  it('is empty while the match is still being played', () => {
    expect(matchStatsFor(match(players, {}, null))).toEqual([]);
  });

  it('counts the result, marks and bids for each player', () => {
    const games: MatchState['games'] = {
      // TeamA: p1 made 30 and 34, p3 made 84 (2 marks); then set p2's Plunge (4 marks).
      [Teams.TeamA]: [
        hand(1, 'p1', Teams.TeamA, Bid.Thirty),
        hand(2, 'p1', Teams.TeamA, Bid.ThirtyFour),
        hand(3, 'p3', Teams.TeamA, Bid.EightyFour),
        hand(5, 'p2', Teams.TeamB, Bid.Plunge),
      ],
      // TeamB: set p1's 36.
      [Teams.TeamB]: [hand(4, 'p1', Teams.TeamA, Bid.ThirtySix)],
    };

    const stats = matchStatsFor(match(players, games, Teams.TeamA));

    expect(stats.find((s) => s.playerId === 'p1')).toEqual({
      playerId: 'p1',
      partnerId: 'p3',
      withBots: false,
      won: true,
      marksWon: 1 + 1 + 2 + 4,
      bidsWon: 3,
      bidsMade: 2,
      pointsBidTotal: 30 + 34 + 36,
      pointsBidCount: 3,
      marksBids: 0,
    });
    expect(stats.find((s) => s.playerId === 'p3')).toMatchObject({ partnerId: 'p1', bidsWon: 1, bidsMade: 1, marksBids: 1, pointsBidCount: 0 });
    expect(stats.find((s) => s.playerId === 'p2')).toEqual({
      playerId: 'p2',
      partnerId: 'p4',
      withBots: false,
      won: false,
      marksWon: 1,
      bidsWon: 1,
      bidsMade: 0,
      pointsBidTotal: 0,
      pointsBidCount: 0,
      marksBids: 1,
    });
  });

  it('counts a made Low bid as made', () => {
    const games = { [Teams.TeamA]: [hand(1, 'p1', Teams.TeamA, Bid.FortyTwo, Suit.Low)] };
    expect(matchStatsFor(match(players, games, Teams.TeamA))[0]).toMatchObject({ bidsWon: 1, bidsMade: 1 });
  });

  it('gives bots no row and marks the humans as playing with bots', () => {
    const stats = matchStatsFor(match(['p1', 'bot-1', 'bot-2', 'bot-3'], {}, Teams.TeamB));
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ playerId: 'p1', partnerId: 'bot-2', withBots: true, won: false });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @fortytwo/rules -- stats`
Expected: FAIL — cannot find module `./stats`.

- [ ] **Step 3: Implement** — `packages/rules/src/stats.ts`

```ts
// What one completed match adds to each human's lifetime stats (the Profile's Stats section). The
// Worker writes one row per human when the match is won (apps/worker/src/stats.ts) and adds them
// up when a player asks. Only filed hands count: a hand is filed under the team that took it as
// soon as it's decided (matchEngine.ts's playDomino), so they are exactly the decided hands.
import { Bid } from './bid';
import { isBot } from './botIds';
import { gameValue, type Game } from './game';
import type { MatchState } from './matchEngine';
import { teamForPosition, type Teams } from './teams';

export interface PlayerMatchStats {
  playerId: string;
  partnerId: string;
  // Any seat at the table held a bot.
  withBots: boolean;
  won: boolean;
  // Marks their team took.
  marksWon: number;
  // Hands they were the high bidder on, and how many of those their team made.
  bidsWon: number;
  bidsMade: number;
  // Their winning points bids (30-42), for an average; bids of 84 and up are marks bids.
  pointsBidTotal: number;
  pointsBidCount: number;
  marksBids: number;
}

export function matchStatsFor(match: MatchState): PlayerMatchStats[] {
  if (match.winningTeam === null) return [];

  const withBots = match.players.some((p) => isBot(p.playerId));
  const filed = (Object.entries(match.games) as [string, Game[] | undefined][]).flatMap(([key, games]) =>
    (games ?? []).map((game) => ({ game, wonBy: Number(key) as Teams }))
  );

  return match.players
    .filter((player) => !isBot(player.playerId))
    .map((player) => {
      const team = teamForPosition(player.position);
      const partner = match.players.find((p) => p.playerId !== player.playerId && teamForPosition(p.position) === team);
      const stats: PlayerMatchStats = {
        playerId: player.playerId,
        partnerId: partner?.playerId ?? '',
        withBots,
        won: match.winningTeam === team,
        marksWon: 0,
        bidsWon: 0,
        bidsMade: 0,
        pointsBidTotal: 0,
        pointsBidCount: 0,
        marksBids: 0,
      };

      for (const { game, wonBy } of filed) {
        if (wonBy === team) stats.marksWon += gameValue(game) ?? 0;
        if (game.biddingPlayerId !== player.playerId) continue;
        const bid = game.hands.find((h) => h.playerId === player.playerId)?.bid ?? null;
        if (bid === null || bid === Bid.Pass) continue;

        stats.bidsWon++;
        if (wonBy === team) stats.bidsMade++;
        if (bid <= Bid.FortyTwo) {
          stats.pointsBidTotal += bid;
          stats.pointsBidCount++;
        } else {
          stats.marksBids++;
        }
      }
      return stats;
    });
}
```

Append to `packages/rules/src/index.ts`:

```ts
export type { PlayerMatchStats } from './stats';
export { matchStatsFor } from './stats';
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -w @fortytwo/rules -- stats && npm run typecheck -w @fortytwo/rules`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/rules/src/stats.ts packages/rules/src/stats.test.ts packages/rules/src/index.ts
git commit -m "feat(rules): work out each player's stats from a completed match"
```

---

### Task 2: API types, `getStats`, and the shared stats formatter

**Files:**
- Modify: `packages/api-types/src/index.ts` (after `ProfilePatch`)
- Modify: `packages/client/src/api.ts` (import list, re-export list, new `getStats` next to `getProfile`)
- Create: `packages/client/src/stats.ts`
- Create: `packages/client/src/stats.test.ts`
- Modify: `packages/client/src/index.ts` (add `export * from './stats';`)

**Interfaces:**
- Produces (api-types):
  ```ts
  export interface BestPartner { user: PublicUser; won: number; lost: number }
  export interface StatsSummary {
    played: number; won: number; lost: number; marksWon: number;
    bidsWon: number; bidsMade: number; bidsSet: number;
    averagePointsBid: number | null; marksBids: number;
    bestPartner: BestPartner | null;
  }
  export interface PlayerStats { all: StatsSummary; humansOnly: StatsSummary; withBots: StatsSummary }
  export type StatsFilter = keyof PlayerStats;
  ```
- Produces (client): `getStats(): Promise<PlayerStats>`; `STATS_FILTERS: { filter: StatsFilter; label: string }[]`; `statTiles(s: StatsSummary): { label: string; value: string }[]`; `bestPartnerRecord(p: BestPartner): string`.

- [ ] **Step 1: Add the types** — in `packages/api-types/src/index.ts` after `ProfilePatch`:

```ts
// The caller's own lifetime stats (GET /api/users/stats), counted from completed matches. A game
// is a whole match; bids are the hands they took the bid on. Each filter is its own summary.
export interface BestPartner {
  user: PublicUser;
  won: number;
  lost: number;
}

export interface StatsSummary {
  played: number;
  won: number;
  lost: number;
  marksWon: number;
  bidsWon: number;
  bidsMade: number;
  bidsSet: number;
  // Over their winning points bids (30-42), to one decimal place; null with none.
  averagePointsBid: number | null;
  // Winning bids of 84 and up, Plunge included.
  marksBids: number;
  // The human they win with most, over at least 3 games together.
  bestPartner: BestPartner | null;
}

export interface PlayerStats {
  all: StatsSummary;
  // No seat held a bot.
  humansOnly: StatsSummary;
  // At least one seat held a bot.
  withBots: StatsSummary;
}

export type StatsFilter = keyof PlayerStats;
```

- [ ] **Step 2: Write the failing formatter test** — `packages/client/src/stats.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import type { StatsSummary } from '@fortytwo/api-types';
import { bestPartnerRecord, statTiles, STATS_FILTERS } from './stats';

const EMPTY: StatsSummary = {
  played: 0, won: 0, lost: 0, marksWon: 0, bidsWon: 0, bidsMade: 0, bidsSet: 0,
  averagePointsBid: null, marksBids: 0, bestPartner: null,
};

describe('statTiles', () => {
  it('shows rates and the average as a dash when there is nothing to divide', () => {
    const values = Object.fromEntries(statTiles(EMPTY).map((t) => [t.label, t.value]));
    expect(values).toEqual({
      Played: '0', Won: '0', Lost: '0', 'Win rate': '–', 'Marks won': '0',
      'Bids won': '0', Made: '0', Set: '0', 'Made rate': '–', 'Avg. points bid': '–', 'Marks bids': '0',
    });
  });

  it('rounds rates to whole percents and keeps one decimal on the average', () => {
    const values = Object.fromEntries(
      statTiles({ ...EMPTY, played: 3, won: 2, lost: 1, bidsWon: 3, bidsMade: 1, bidsSet: 2, averagePointsBid: 31.5 }).map(
        (t) => [t.label, t.value]
      )
    );
    expect(values['Win rate']).toBe('67%');
    expect(values['Made rate']).toBe('33%');
    expect(values['Avg. points bid']).toBe('31.5');
  });
});

describe('bestPartnerRecord', () => {
  it('reads as wins and losses together', () => {
    expect(bestPartnerRecord({ user: { user_id: 'u', displayName: 'Sam' }, won: 7, lost: 2 })).toBe('7–2 together');
  });
});

describe('STATS_FILTERS', () => {
  it('lists the three filters in order', () => {
    expect(STATS_FILTERS.map((f) => f.label)).toEqual(['All', 'Humans only', 'With bots']);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npm test -w @fortytwo/client -- stats`
Expected: FAIL — cannot find module `./stats`.

- [ ] **Step 4: Implement** — `packages/client/src/stats.ts`

```ts
// How the Profile's Stats section reads, shared by the web and mobile apps: the filters, and each
// figure as a label and the text to show. A rate with nothing to divide by shows as a dash.
import type { BestPartner, StatsFilter, StatsSummary } from '@fortytwo/api-types';

export const STATS_FILTERS: { filter: StatsFilter; label: string }[] = [
  { filter: 'all', label: 'All' },
  { filter: 'humansOnly', label: 'Humans only' },
  { filter: 'withBots', label: 'With bots' },
];

export interface StatTile {
  label: string;
  value: string;
}

function rate(part: number, whole: number): string {
  return whole === 0 ? '–' : `${Math.round((part / whole) * 100)}%`;
}

export function statTiles(s: StatsSummary): StatTile[] {
  return [
    { label: 'Played', value: String(s.played) },
    { label: 'Won', value: String(s.won) },
    { label: 'Lost', value: String(s.lost) },
    { label: 'Win rate', value: rate(s.won, s.played) },
    { label: 'Marks won', value: String(s.marksWon) },
    { label: 'Bids won', value: String(s.bidsWon) },
    { label: 'Made', value: String(s.bidsMade) },
    { label: 'Set', value: String(s.bidsSet) },
    { label: 'Made rate', value: rate(s.bidsMade, s.bidsWon) },
    { label: 'Avg. points bid', value: s.averagePointsBid === null ? '–' : s.averagePointsBid.toFixed(1) },
    { label: 'Marks bids', value: String(s.marksBids) },
  ];
}

export function bestPartnerRecord(partner: BestPartner): string {
  return `${partner.won}–${partner.lost} together`;
}
```

Add `export * from './stats';` to `packages/client/src/index.ts` (alphabetically after `./poke`). In `packages/client/src/api.ts` add `PlayerStats` to the `@fortytwo/api-types` import and to the `export type { ... }` line, and after `getProfile`:

```ts
    // The caller's own lifetime stats, for the Profile.
    getStats: (): Promise<PlayerStats> => request<PlayerStats>('/api/users/stats'),
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -w @fortytwo/client && npm run typecheck -w @fortytwo/api-types && npm run typecheck -w @fortytwo/client`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api-types/src/index.ts packages/client/src
git commit -m "feat(client): stats types, getStats and the shared stats tiles"
```

---

### Task 3: D1 table, writing and reading stats in the Worker

**Files:**
- Create: `apps/worker/migrations/0009_player_match_stats.sql`
- Create: `apps/worker/src/stats.ts`
- Create: `apps/worker/test/stats.test.ts`

**Interfaces:**
- Consumes: `matchStatsFor`, `isBot` (`@fortytwo/rules`); `publicUsers(env, ids)` (`src/users/publicUsers.ts`); `PlayerStats`, `StatsSummary` (`@fortytwo/api-types`).
- Produces: `recordMatchStats(db: D1Database, match: MatchState): Promise<void>`; `readPlayerStats(env: Env, playerId: string): Promise<PlayerStats>`; `BEST_PARTNER_MIN_GAMES = 3`.

- [ ] **Step 1: Migration** — `apps/worker/migrations/0009_player_match_stats.sql`

```sql
-- Each human's figures from one completed match (stats.ts), for the Profile's Stats section: one
-- row per human, written once when the match is won, added up when they ask. Counted from launch:
-- matches completed before this table existed aren't in it. No reference to `matches` - stats
-- outlive the lobby index's rows.
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
  completed_on TEXT NOT NULL,
  PRIMARY KEY (match_id, player_id)
);

CREATE INDEX idx_player_match_stats_player ON player_match_stats(player_id);
```

- [ ] **Step 2: Write the failing test** — `apps/worker/test/stats.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { Bid, Teams, type Game, type MatchState, type Positions } from '@fortytwo/rules';
import type { Env } from '../src/index';
import { readPlayerStats, recordMatchStats } from '../src/stats';
import { saveUsers } from '../src/users/publicUsers';

const testEnv = env as unknown as Env;

function hand(n: number, bidder: string, bidderTeam: Teams, bid: Bid): Game {
  return {
    id: `g${n}`, name: `Game ${n}`, firstActionBy: null, bid, biddingPlayerId: bidder, trump: 6,
    currentPlayerId: null, hands: [{ playerId: bidder, team: bidderTeam, dominoes: [], bid }],
    currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] }, tricks: [],
  };
}

// A won match: seats 0 & 2 are TeamA. TeamA's filed hands are bid by seat 0 (30 each).
function won(id: string, players: string[], winner: Teams, marks = 7): MatchState {
  const bidder = players[winner === Teams.TeamA ? 0 : 1];
  return {
    id, createdOn: '2026-10-01T00:00:00.000Z', updatedOn: '2026-10-01T01:00:00.000Z', winningTeam: winner,
    games: { [winner]: Array.from({ length: marks }, (_, i) => hand(i, bidder, winner, Bid.Thirty)) },
    players: players.map((playerId, position) => ({ playerId, position: position as Positions, ready: true })),
    currentGame: hand(99, players[0], Teams.TeamA, Bid.Thirty),
  };
}

beforeEach(async () => {
  await testEnv.DB.batch([testEnv.DB.prepare('DELETE FROM player_match_stats'), testEnv.DB.prepare('DELETE FROM users')]);
  await saveUsers(testEnv.DB, [
    { user_id: 'sam', displayName: 'Sam' },
    { user_id: 'kim', displayName: 'Kim' },
  ]);
});

describe('recordMatchStats', () => {
  it('writes one row per human, and writing again changes nothing', async () => {
    const match = won('m1', ['me', 'bot-1', 'sam', 'bot-2'], Teams.TeamA);
    await recordMatchStats(testEnv.DB, match);
    await recordMatchStats(testEnv.DB, match);

    const { results } = await testEnv.DB.prepare('SELECT player_id, with_bots, won FROM player_match_stats ORDER BY player_id').all();
    expect(results).toEqual([
      { player_id: 'me', with_bots: 1, won: 1 },
      { player_id: 'sam', with_bots: 1, won: 1 },
    ]);
  });

  it('writes nothing for a match not yet won', async () => {
    await recordMatchStats(testEnv.DB, { ...won('m2', ['a', 'b', 'c', 'd'], Teams.TeamA), winningTeam: null });
    const row = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM player_match_stats').first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe('readPlayerStats', () => {
  it('is all zeros with no best partner for a player with no games', async () => {
    const stats = await readPlayerStats(testEnv, 'nobody');
    for (const summary of [stats.all, stats.humansOnly, stats.withBots]) {
      expect(summary).toEqual({
        played: 0, won: 0, lost: 0, marksWon: 0, bidsWon: 0, bidsMade: 0, bidsSet: 0,
        averagePointsBid: null, marksBids: 0, bestPartner: null,
      });
    }
  });

  it('adds up each filter, and All is both together', async () => {
    // Humans only: won twice with sam, lost once with kim. With bots: won once with bot-2.
    await recordMatchStats(testEnv.DB, won('h1', ['me', 'x', 'sam', 'y'], Teams.TeamA));
    await recordMatchStats(testEnv.DB, won('h2', ['me', 'x', 'sam', 'y'], Teams.TeamA));
    await recordMatchStats(testEnv.DB, won('h3', ['me', 'x', 'kim', 'y'], Teams.TeamB));
    await recordMatchStats(testEnv.DB, won('b1', ['me', 'bot-1', 'bot-2', 'bot-3'], Teams.TeamA));

    const stats = await readPlayerStats(testEnv, 'me');

    expect(stats.humansOnly).toMatchObject({ played: 3, won: 2, lost: 1, marksWon: 14, bidsWon: 14, bidsMade: 14, bidsSet: 0, averagePointsBid: 30 });
    expect(stats.withBots).toMatchObject({ played: 1, won: 1, lost: 0, marksWon: 7 });
    expect(stats.all).toMatchObject({ played: 4, won: 3, lost: 1, marksWon: 21, bidsWon: 21 });
  });

  it('names the best human partner over at least 3 games, never a bot', async () => {
    // sam: 2-1 over 3 games. kim: 2-0 over 2 games (too few). bot-2: 4-0 (a bot).
    await recordMatchStats(testEnv.DB, won('s1', ['me', 'x', 'sam', 'y'], Teams.TeamA));
    await recordMatchStats(testEnv.DB, won('s2', ['me', 'x', 'sam', 'y'], Teams.TeamA));
    await recordMatchStats(testEnv.DB, won('s3', ['me', 'x', 'sam', 'y'], Teams.TeamB));
    await recordMatchStats(testEnv.DB, won('k1', ['me', 'x', 'kim', 'y'], Teams.TeamA));
    await recordMatchStats(testEnv.DB, won('k2', ['me', 'x', 'kim', 'y'], Teams.TeamA));
    for (const id of ['b1', 'b2', 'b3', 'b4']) {
      await recordMatchStats(testEnv.DB, won(id, ['me', 'bot-1', 'bot-2', 'bot-3'], Teams.TeamA));
    }

    const stats = await readPlayerStats(testEnv, 'me');

    expect(stats.all.bestPartner).toEqual({ user: { user_id: 'sam', displayName: 'Sam' }, won: 2, lost: 1 });
    expect(stats.humansOnly.bestPartner?.user.user_id).toBe('sam');
    expect(stats.withBots.bestPartner).toBeNull();
  });

  it('breaks a tie in win rate by more games together', async () => {
    for (const id of ['s1', 's2', 's3']) await recordMatchStats(testEnv.DB, won(id, ['me', 'x', 'sam', 'y'], Teams.TeamA));
    for (const id of ['k1', 'k2', 'k3', 'k4']) await recordMatchStats(testEnv.DB, won(id, ['me', 'x', 'kim', 'y'], Teams.TeamA));
    expect((await readPlayerStats(testEnv, 'me')).all.bestPartner?.user.displayName).toBe('Kim');
  });

  it('still answers when the best partner has no name on record', async () => {
    for (const id of ['g1', 'g2', 'g3']) await recordMatchStats(testEnv.DB, won(id, ['me', 'x', 'ghost', 'y'], Teams.TeamA));
    const partner = (await readPlayerStats(testEnv, 'me')).all.bestPartner;
    expect(partner).toEqual({ user: { user_id: 'ghost', displayName: 'A former player' }, won: 3, lost: 0 });
  });
});
```

Note on the "ghost" case: `publicUsers` asks Auth0 about ids not in D1. The worker test pool has `fetchMock.disableNetConnect()` set by other files but not this one; check `apps/worker/test/publicUsers.test.ts` for how it stubs Auth0. If a call goes out, mock it the same way so Auth0 replies with no users (an empty list), which leaves `ghost` unnamed. The fallback name must be exactly `'A former player'`.

- [ ] **Step 3: Run it to make sure it fails**

Run: `npm test -w @fortytwo/worker -- stats`
Expected: FAIL — cannot find module `../src/stats`.

- [ ] **Step 4: Implement** — `apps/worker/src/stats.ts`

```ts
// Each player's lifetime stats (migrations/0009_player_match_stats.sql): written once per human
// when a match is won (MatchDO), added up when they open their Profile (GET /api/users/stats).
// Reading costs about two rows per game the player has finished - the totals, then the partners.
import { isBot, matchStatsFor, type MatchState } from '@fortytwo/rules';
import type { BestPartner, PlayerStats, StatsSummary } from '@fortytwo/api-types';
import type { Env } from './index';
import { publicUsers } from './users/publicUsers';

export const BEST_PARTNER_MIN_GAMES = 3;
const UNKNOWN_PARTNER_NAME = 'A former player';

// One row per human. INSERT OR IGNORE: writing a match twice changes nothing.
export async function recordMatchStats(db: D1Database, match: MatchState): Promise<void> {
  const rows = matchStatsFor(match);
  if (rows.length === 0) return;
  await db.batch(
    rows.map((r) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO player_match_stats (match_id, player_id, partner_id, with_bots, won, marks_won,
             bids_won, bids_made, points_bid_total, points_bid_count, marks_bids, completed_on)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
        )
        .bind(
          match.id, r.playerId, r.partnerId, r.withBots ? 1 : 0, r.won ? 1 : 0, r.marksWon,
          r.bidsWon, r.bidsMade, r.pointsBidTotal, r.pointsBidCount, r.marksBids, match.updatedOn
        )
    )
  );
}

interface Totals {
  played: number;
  won: number;
  marksWon: number;
  bidsWon: number;
  bidsMade: number;
  pointsBidTotal: number;
  pointsBidCount: number;
  marksBids: number;
}

interface PartnerRecord {
  partnerId: string;
  played: number;
  won: number;
}

const NO_TOTALS: Totals = { played: 0, won: 0, marksWon: 0, bidsWon: 0, bidsMade: 0, pointsBidTotal: 0, pointsBidCount: 0, marksBids: 0 };

function addTotals(a: Totals, b: Totals): Totals {
  return {
    played: a.played + b.played,
    won: a.won + b.won,
    marksWon: a.marksWon + b.marksWon,
    bidsWon: a.bidsWon + b.bidsWon,
    bidsMade: a.bidsMade + b.bidsMade,
    pointsBidTotal: a.pointsBidTotal + b.pointsBidTotal,
    pointsBidCount: a.pointsBidCount + b.pointsBidCount,
    marksBids: a.marksBids + b.marksBids,
  };
}

// Highest win rate over enough games, then more games, then id - so the same rows always pick
// the same partner. Bots never count.
function bestOf(records: PartnerRecord[]): PartnerRecord | null {
  const eligible = records.filter((r) => !isBot(r.partnerId) && r.partnerId !== '' && r.played >= BEST_PARTNER_MIN_GAMES);
  eligible.sort(
    (a, b) => b.won / b.played - a.won / a.played || b.played - a.played || a.partnerId.localeCompare(b.partnerId)
  );
  return eligible[0] ?? null;
}

// Each partner's record across both bot groups, for All.
function mergePartners(records: PartnerRecord[]): PartnerRecord[] {
  const byId = new Map<string, PartnerRecord>();
  for (const r of records) {
    const seen = byId.get(r.partnerId);
    byId.set(r.partnerId, seen ? { ...seen, played: seen.played + r.played, won: seen.won + r.won } : { ...r });
  }
  return [...byId.values()];
}

function summarize(t: Totals, best: BestPartner | null): StatsSummary {
  return {
    played: t.played,
    won: t.won,
    lost: t.played - t.won,
    marksWon: t.marksWon,
    bidsWon: t.bidsWon,
    bidsMade: t.bidsMade,
    bidsSet: t.bidsWon - t.bidsMade,
    averagePointsBid: t.pointsBidCount === 0 ? null : Math.round((t.pointsBidTotal / t.pointsBidCount) * 10) / 10,
    marksBids: t.marksBids,
    bestPartner: best,
  };
}

export async function readPlayerStats(env: Env, playerId: string): Promise<PlayerStats> {
  const [totalsResult, partnersResult] = await env.DB.batch([
    env.DB.prepare(
      `SELECT with_bots AS withBots, COUNT(*) AS played, SUM(won) AS won, SUM(marks_won) AS marksWon,
         SUM(bids_won) AS bidsWon, SUM(bids_made) AS bidsMade, SUM(points_bid_total) AS pointsBidTotal,
         SUM(points_bid_count) AS pointsBidCount, SUM(marks_bids) AS marksBids
       FROM player_match_stats WHERE player_id = ? GROUP BY with_bots`
    ).bind(playerId),
    env.DB.prepare(
      `SELECT partner_id AS partnerId, with_bots AS withBots, COUNT(*) AS played, SUM(won) AS won
       FROM player_match_stats WHERE player_id = ? GROUP BY partner_id, with_bots`
    ).bind(playerId),
  ]);
  const totals = totalsResult.results as (Totals & { withBots: number })[];
  const partners = partnersResult.results as (PartnerRecord & { withBots: number })[];

  const humansTotals = totals.find((t) => t.withBots === 0) ?? NO_TOTALS;
  const botsTotals = totals.find((t) => t.withBots === 1) ?? NO_TOTALS;
  const best = {
    all: bestOf(mergePartners(partners)),
    humansOnly: bestOf(partners.filter((p) => p.withBots === 0)),
    withBots: bestOf(partners.filter((p) => p.withBots === 1)),
  };

  const ids = [...new Set(Object.values(best).flatMap((b) => (b ? [b.partnerId] : [])))];
  const { users } = ids.length > 0 ? await publicUsers(env, ids) : { users: [] };
  const partnerOf = (record: PartnerRecord | null): BestPartner | null =>
    record && {
      user: users.find((u) => u.user_id === record.partnerId) ?? { user_id: record.partnerId, displayName: UNKNOWN_PARTNER_NAME },
      won: record.won,
      lost: record.played - record.won,
    };

  return {
    all: summarize(addTotals(humansTotals, botsTotals), partnerOf(best.all)),
    humansOnly: summarize(humansTotals, partnerOf(best.humansOnly)),
    withBots: summarize(botsTotals, partnerOf(best.withBots)),
  };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -w @fortytwo/worker -- stats && npm run typecheck -w @fortytwo/worker`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/migrations/0009_player_match_stats.sql apps/worker/src/stats.ts apps/worker/test/stats.test.ts
git commit -m "feat(worker): store and add up each player's match stats"
```

---

### Task 4: Record stats when a match is won (MatchDO)

**Files:**
- Modify: `apps/worker/src/matchDO.ts` (`update`, `alarm`, new private `recordStats`)
- Create: `apps/worker/test/almostWonMatch.ts`
- Create: `apps/worker/test/matchDOStats.test.ts`

**Interfaces:**
- Consumes: `recordMatchStats(db, match)` from Task 3.
- Produces: `almostWonMatch(id, players?)` test fixture — a match whose next play (by `players[3]`, holding one domino `1-3`) wins it for TeamA.

- [ ] **Step 1: Fixture** — `apps/worker/test/almostWonMatch.ts`

```ts
import { Bid, Suit, Teams, createDomino, type Domino, type Game, type MatchState, type Positions, type Trick } from '@fortytwo/rules';

// A match one play from over: TeamA (seats 0 & 2) has 6 marks, and in the 7th hand (seat 0 bid 30,
// Sixes trump) TeamA holds 28 points. Seat 0 led the 6-6 to the last trick and seats 1-2 followed;
// seat 3 plays its last domino, 1-3, and the 6-6 takes the trick (and the 4-1's 5 count): 34
// points makes the bid, the 7th mark wins the match.
function trick(team: Teams, playerId: string, dominoes: Domino[]): Trick {
  return { playerId, team, suit: Suit.Sixes, dominoes: [...dominoes, ...Array(4 - dominoes.length).fill(null)] };
}

function filedHand(n: number, players: string[]): Game {
  return {
    id: `filed-${n}`, name: `Game ${n}`, firstActionBy: players[0], bid: Bid.Thirty, biddingPlayerId: players[0],
    trump: Suit.Sixes, currentPlayerId: null,
    hands: players.map((playerId, seat) => ({ playerId, team: seat % 2 === 0 ? Teams.TeamA : Teams.TeamB, dominoes: [], bid: seat === 0 ? Bid.Thirty : Bid.Pass })),
    currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] }, tricks: [],
  };
}

export function almostWonMatch(id: string, players = ['p1', 'p2', 'p3', 'p4']): MatchState {
  const [a, b] = players;
  const d = createDomino;
  return {
    id, createdOn: '2026-10-01T00:00:00.000Z', updatedOn: '2026-10-01T00:00:00.000Z', winningTeam: null,
    games: { [Teams.TeamA]: [1, 2, 3, 4, 5, 6].map((n) => filedHand(n, players)) },
    players: players.map((playerId, position) => ({ playerId, position: position as Positions, ready: true })),
    currentGame: {
      ...filedHand(7, players),
      id: 'current', currentPlayerId: players[3],
      hands: players.map((playerId, seat) => ({
        playerId, team: seat % 2 === 0 ? Teams.TeamA : Teams.TeamB,
        dominoes: seat === 3 ? [d(1, 3)] : [], bid: seat === 0 ? Bid.Thirty : Bid.Pass,
      })),
      tricks: [
        trick(Teams.TeamA, a, [d(5, 5)]), trick(Teams.TeamA, a, [d(6, 4)]), trick(Teams.TeamA, a, [d(5, 0)]),
        trick(Teams.TeamB, b, [d(0, 0)]), trick(Teams.TeamB, b, [d(1, 1)]), trick(Teams.TeamB, b, [d(2, 2)]),
      ],
      currentTrick: { playerId: a, team: Teams.TeamA, suit: Suit.Sixes, dominoes: [d(6, 6), d(4, 1), d(3, 3), null] },
    },
  };
}
```

- [ ] **Step 2: Write the failing test** — `apps/worker/test/matchDOStats.test.ts`

```ts
// Stats are recorded by the play that wins a match - from a route (update) or a bot (alarm) - and
// by nothing else; a D1 failure is logged loudly and the play still goes through.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { createDomino, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import type { MatchDO } from '../src/matchDO';
import { almostWonMatch } from './almostWonMatch';
import { failingDb } from './failingDb';

const testEnv = env as unknown as Env;

async function seed(name: string, match: MatchState) {
  const stub = testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('match', match);
  });
  return stub;
}

async function statsRows(matchId: string) {
  const { results } = await testEnv.DB.prepare(
    'SELECT player_id AS playerId, won, marks_won AS marksWon, bids_won AS bidsWon, with_bots AS withBots FROM player_match_stats WHERE match_id = ? ORDER BY player_id'
  )
    .bind(matchId)
    .all();
  return results;
}

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM player_match_stats').run();
});

describe('MatchDO player stats', () => {
  it('records every human once when a play wins the match', async () => {
    const stub = await seed('stats-win', almostWonMatch('stats-win'));

    const result = await stub.playDomino('p4', createDomino(1, 3));
    expect(result.ok && result.value.winningTeam).toBeTruthy();

    expect(await statsRows('stats-win')).toEqual([
      { playerId: 'p1', won: 1, marksWon: 7, bidsWon: 7, withBots: 0 },
      { playerId: 'p2', won: 0, marksWon: 0, bidsWon: 0, withBots: 0 },
      { playerId: 'p3', won: 1, marksWon: 7, bidsWon: 0, withBots: 0 },
      { playerId: 'p4', won: 0, marksWon: 0, bidsWon: 0, withBots: 0 },
    ]);
  });

  it('records nothing for a play that does not win the match', async () => {
    const match = almostWonMatch('stats-none');
    // One mark short: the same play makes the hand but leaves TeamA on 6.
    const stub = await seed('stats-none', { ...match, games: { 1: match.games[1]!.slice(1) } });
    await stub.playDomino('p4', createDomino(1, 3));
    expect(await statsRows('stats-none')).toEqual([]);
  });

  it('records nothing for plays after the match is already won', async () => {
    const stub = await seed('stats-after', almostWonMatch('stats-after'));
    await stub.playDomino('p4', createDomino(1, 3));
    await testEnv.DB.prepare('DELETE FROM player_match_stats').run();
    // Saving a won match back as the "previous" state: any later play starts from winningTeam set.
    const won = await stub.getMatch();
    if (!won.ok) throw new Error('expected the match');
    await runInDurableObject(stub, async (instance: MatchDO) => {
      // Drive update() with an action that changes nothing about the result.
      await (instance as unknown as { update: (id: string, a: (m: MatchState) => MatchState) => Promise<unknown> }).update(
        'p1',
        (m) => ({ ...m, updatedOn: new Date().toISOString() })
      );
    });
    expect(await statsRows('stats-after')).toEqual([]);
  });

  it('records the match when a bot makes the winning play', async () => {
    const stub = await seed('stats-bot', almostWonMatch('stats-bot', ['p1', 'bot-1', 'p3', 'bot-2']));
    // The seeded state is bot-2's turn; arm the alarm the way scheduleBotsIfNeeded would.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now());
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await statsRows('stats-bot')).toEqual([
      { playerId: 'p1', won: 1, marksWon: 7, bidsWon: 7, withBots: 1 },
      { playerId: 'p3', won: 1, marksWon: 7, bidsWon: 0, withBots: 1 },
    ]);
  });

  it('logs loudly and still wins the match when D1 is down', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = await seed('stats-no-db', almostWonMatch('stats-no-db'));
    let realEnv: Env | undefined;
    await runInDurableObject(stub, async (instance: MatchDO) => {
      const withEnv = instance as unknown as { env: Env };
      realEnv = withEnv.env;
      withEnv.env = { ...realEnv, DB: failingDb() };
    });
    try {
      const result = await stub.playDomino('p4', createDomino(1, 3));
      expect(result.ok && result.value.winningTeam).toBeTruthy();
      expect(logged).toHaveBeenCalledWith('PLAYER STATS WRITE FAILED for match stats-no-db', expect.any(Error));
    } finally {
      await runInDurableObject(stub, async (instance: MatchDO) => {
        (instance as unknown as { env: Env }).env = realEnv!;
      });
      logged.mockRestore();
    }
  });
});
```

If the "already won" test's direct `update` call proves awkward (it's private), replace it with: seed `{ ...wonMatch }` where `wonMatch` is the result of the first winning play, keep a domino in some player's hand so a further `playDomino` is legal, and assert no rows after that play. The behavior pinned is: a play starting from `winningTeam !== null` writes nothing.

- [ ] **Step 3: Run it to make sure it fails**

Run: `npm test -w @fortytwo/worker -- matchDOStats`
Expected: FAIL — no rows written for the winning play (and no log line).

- [ ] **Step 4: Implement** — in `apps/worker/src/matchDO.ts`

Add the import:

```ts
import { recordMatchStats } from './stats';
```

In `update`, after `this.publish(match, next, [actorId]);`:

```ts
      await this.recordStatsIfWon(match, next);
```

In `alarm`, after `this.publish(match, next);`:

```ts
    await this.recordStatsIfWon(match, next);
```

New private method (next to `scheduleBotsIfNeeded`):

```ts
  // The play that wins the match records each human's stats (stats.ts) - only that one, so plays
  // after the match is over write nothing. A failure is logged loudly rather than thrown, like the
  // lobby sync: the play is already saved. Stats are counted from launch with no backfill, so a
  // failed write leaves that match out; watch the logs for this line.
  private async recordStatsIfWon(previous: MatchState, next: MatchState): Promise<void> {
    if (previous.winningTeam !== null || next.winningTeam === null) return;
    try {
      await recordMatchStats(this.env.DB, next);
    } catch (error) {
      console.error(`PLAYER STATS WRITE FAILED for match ${next.id}`, error);
    }
  }
```

- [ ] **Step 5: Run the worker suite and typecheck**

Run: `npm test -w @fortytwo/worker && npm run typecheck -w @fortytwo/worker`
Expected: all PASS (existing DO tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/matchDO.ts apps/worker/test/almostWonMatch.ts apps/worker/test/matchDOStats.test.ts
git commit -m "feat(worker): record player stats on the play that wins a match"
```

---

### Task 5: `GET /api/users/stats`

**Files:**
- Modify: `apps/worker/src/routes/users.ts`
- Modify: `apps/worker/test/routes.users.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `readPlayerStats(env, playerId)`, `recordMatchStats` (Task 3); `almostWonMatch`-free — use direct inserts.

- [ ] **Step 1: Write the failing test** — add to `apps/worker/test/routes.users.test.ts` (reuse the file's `api(path, sub)` helper; add `recordMatchStats` and rules imports at the top):

```ts
describe('GET /api/users/stats', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM player_match_stats').run();
  });

  it("returns the caller's own stats and nobody else's", async () => {
    await env.DB.batch(
      ['caller', 'other'].map((player, i) =>
        env.DB.prepare(
          `INSERT INTO player_match_stats (match_id, player_id, partner_id, with_bots, won, marks_won, bids_won,
             bids_made, points_bid_total, points_bid_count, marks_bids, completed_on)
           VALUES (?, ?, 'p', 0, ?, 7, 2, 1, 64, 2, 0, '2026-10-01T00:00:00.000Z')`
        ).bind(`m${i}`, player, i === 0 ? 1 : 0)
      )
    );

    const res = await api('/api/users/stats', 'caller');

    expect(res.status).toBe(200);
    const body = await res.json<PlayerStats>();
    expect(body.all).toMatchObject({ played: 1, won: 1, lost: 0, marksWon: 7, bidsWon: 2, bidsMade: 1, bidsSet: 1, averagePointsBid: 32 });
    expect(body.withBots.played).toBe(0);
  });

  it('needs a signed-in caller', async () => {
    const res = await SELF.fetch('https://example.com/api/users/stats');
    expect(res.status).toBe(401);
  });
});
```

Import `type PlayerStats` from `@fortytwo/api-types`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @fortytwo/worker -- routes.users`
Expected: FAIL — 404 for `/api/users/stats`.

- [ ] **Step 3: Implement** — in `apps/worker/src/routes/users.ts`, import `readPlayerStats` from `'../stats'` and add after the `/profile` route:

```ts
// The caller's own lifetime stats for the Profile (stats.ts). Only ever their own: no route reads
// another player's.
users.get('/stats', async (c) => c.json(await readPlayerStats(c.env, c.get('user').sub)));
```

Also update the file's header comment to mention the stats table.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -w @fortytwo/worker && npm run typecheck -w @fortytwo/worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/routes/users.ts apps/worker/test/routes.users.test.ts
git commit -m "feat(worker): GET /api/users/stats for the caller's own stats"
```

---

### Task 6: Web — Stats section on the Profile

**Files:**
- Create: `apps/web/src/components/PlayerStats.tsx`
- Create: `apps/web/src/components/PlayerStats.test.tsx`
- Modify: `apps/web/src/pages/Profile.tsx` (render `<PlayerStats />` between the form and `<TurnAlertSettings />`; update header comment)
- Modify: `apps/web/src/pages/Profile.css` (stats grid)
- Modify: `apps/web/src/pages/Profile.test.tsx` (mock gains `getStats`)

**Interfaces:**
- Consumes: `apiClient(getToken).getStats()`; `STATS_FILTERS`, `statTiles`, `bestPartnerRecord` from `@fortytwo/client`; types `PlayerStats`, `StatsFilter` from `@fortytwo/api-types`.

- [ ] **Step 1: Write the failing test** — `apps/web/src/components/PlayerStats.test.tsx`

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerStats as Stats, StatsSummary } from '@fortytwo/api-types';
import { PlayerStats } from './PlayerStats';

const { getStatsMock } = vi.hoisted(() => ({ getStatsMock: vi.fn() }));

vi.mock('../api/client', () => ({ apiClient: () => ({ getStats: getStatsMock }) }));
vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({ getAccessTokenSilently: vi.fn(async () => 'test-token') }),
}));

const EMPTY: StatsSummary = {
  played: 0, won: 0, lost: 0, marksWon: 0, bidsWon: 0, bidsMade: 0, bidsSet: 0,
  averagePointsBid: null, marksBids: 0, bestPartner: null,
};

const STATS: Stats = {
  all: { ...EMPTY, played: 5, won: 3, lost: 2, bestPartner: { user: { user_id: 's', displayName: 'Sam' }, won: 3, lost: 1 } },
  humansOnly: { ...EMPTY, played: 4, won: 3, lost: 1 },
  withBots: { ...EMPTY, played: 1, won: 0, lost: 1 },
};

function renderStats() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PlayerStats />
    </QueryClientProvider>
  );
}

function tile(label: string): string | null {
  return screen.getByText(label).closest('.stat-tile')?.querySelector('.stat-value')?.textContent ?? null;
}

afterEach(() => vi.clearAllMocks());

describe('PlayerStats', () => {
  it('shows All by default, with the best partner', async () => {
    getStatsMock.mockResolvedValue(STATS);
    renderStats();

    expect(await screen.findByText('Sam')).not.toBeNull();
    expect(tile('Played')).toBe('5');
    expect(tile('Win rate')).toBe('60%');
    expect(screen.getByText('3–1 together')).not.toBeNull();
  });

  it('switches figures with the filter', async () => {
    getStatsMock.mockResolvedValue(STATS);
    renderStats();
    await screen.findByText('Sam');

    fireEvent.click(screen.getByLabelText('With bots'));

    expect(tile('Played')).toBe('1');
    expect(tile('Win rate')).toBe('0%');
    expect(screen.queryByText('Sam')).toBeNull();
  });

  it('invites a first game when nothing is counted yet', async () => {
    getStatsMock.mockResolvedValue({ all: EMPTY, humansOnly: EMPTY, withBots: EMPTY });
    renderStats();
    expect(await screen.findByText('Finish a game to see your stats here.')).not.toBeNull();
  });

  it('shows an error without breaking the page', async () => {
    getStatsMock.mockRejectedValue(new Error('Stats are down'));
    renderStats();
    expect((await screen.findByRole('alert')).textContent).toContain('Stats are down');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @fortytwo/web -- PlayerStats`
Expected: FAIL — cannot find `./PlayerStats`.

- [ ] **Step 3: Implement** — `apps/web/src/components/PlayerStats.tsx`

```tsx
// The Profile page's Stats card: the player's own record from completed games (GET
// /api/users/stats), filtered to All, Humans only or With bots. Its own query, so a failure here
// leaves the rest of the Profile working. The figures and their wording come from
// @fortytwo/client's statTiles, shared with the mobile app.
import { useState } from 'react';
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { StatsFilter } from '@fortytwo/api-types';
import { bestPartnerRecord, STATS_FILTERS, statTiles } from '@fortytwo/client';
import { useGetToken } from '../auth/useGetToken';
import { apiClient } from '../api/client';

export function PlayerStats(): JSX.Element {
  const client = apiClient(useGetToken());
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => client.getStats() });
  const [filter, setFilter] = useState<StatsFilter>('all');

  const summary = stats.data?.[filter];

  return (
    <section className="profile-card mat-panel" aria-labelledby="stats-title">
      <h2 id="stats-title" className="profile-section-title">
        Stats
      </h2>

      {stats.isLoading && <div className="spinner" role="status" aria-label="Loading stats" />}

      {stats.error != null && (
        <p role="alert" className="page-error">
          {stats.error instanceof Error ? stats.error.message : 'Something went wrong.'}
        </p>
      )}

      {stats.data && stats.data.all.played === 0 && <p className="profile-hint">Finish a game to see your stats here.</p>}

      {summary && stats.data.all.played > 0 && (
        <>
          <fieldset className="form-group">
            <legend className="visually-hidden">Which games</legend>
            <div className="profile-choices">
              {STATS_FILTERS.map(({ filter: value, label }) => (
                <label key={value} className="profile-choice">
                  <input
                    type="radio"
                    name="statsFilter"
                    value={value}
                    checked={filter === value}
                    onChange={() => setFilter(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <dl className="stat-grid">
            {statTiles(summary).map(({ label, value }) => (
              <div key={label} className="stat-tile">
                <dt className="stat-label">{label}</dt>
                <dd className="stat-value">{value}</dd>
              </div>
            ))}
          </dl>

          {summary.bestPartner && (
            <p className="stat-partner">
              Best partner: <strong>{summary.bestPartner.user.displayName}</strong>{' '}
              <span className="stat-partner-record">{bestPartnerRecord(summary.bestPartner)}</span>
            </p>
          )}
        </>
      )}
    </section>
  );
}
```

Check `apps/web/src/styles` for an existing visually-hidden utility class (`grep -rn "visually-hidden\|sr-only" apps/web/src/styles`); use whichever exists, or add `.visually-hidden` to `Profile.css` with the standard clip pattern.

Append to `apps/web/src/pages/Profile.css`:

```css
/* PlayerStats.tsx: a grid of small inset tiles, each a figure over its label. */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(6.5rem, 1fr));
  gap: 0.5rem;
  margin: 0;
}

.stat-tile {
  display: flex;
  flex-direction: column-reverse;
  padding: 0.6rem 0.75rem;
  border-radius: 8px;
  background: rgba(20, 13, 9, 0.45);
}

.stat-label {
  color: var(--ink-muted);
  font-size: 0.8rem;
}

.stat-value {
  margin: 0;
  color: var(--bone);
  font-family: var(--font-display);
  font-size: 1.4rem;
  font-weight: 700;
}

.stat-partner {
  margin: 0;
  color: var(--bone);
}

.stat-partner-record {
  color: var(--ink-muted);
}
```

In `Profile.tsx`: `import { PlayerStats } from '../components/PlayerStats';`, render `<PlayerStats />` just before `<TurnAlertSettings />`, and add a line to the header comment ("Then the Stats card (components/PlayerStats.tsx) - the player's own record, loaded on its own."). In `Profile.test.tsx` add `getStats: vi.fn(() => new Promise(() => {}))` to the mocked client so existing tests are unaffected.

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `npm test -w @fortytwo/web && npm run typecheck -w @fortytwo/web && npm run lint -w @fortytwo/web`
Expected: PASS.

- [ ] **Step 5: Look at it** — run the app (use the `run` skill or `npm run dev -w @fortytwo/web`) and check the card renders at phone width; screenshot if possible. If the dev server can't reach a signed-in worker, note that and rely on the tests.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/PlayerStats.tsx apps/web/src/components/PlayerStats.test.tsx apps/web/src/pages/Profile.tsx apps/web/src/pages/Profile.css apps/web/src/pages/Profile.test.tsx
git commit -m "feat(web): stats on the Profile"
```

---

### Task 7: Mobile — Stats section on the Profile

**Files:**
- Create: `apps/mobile/src/api/useStats.ts`
- Create: `apps/mobile/src/components/PlayerStats.tsx`
- Create: `apps/mobile/src/components/__tests__/playerStats.test.tsx`
- Modify: `apps/mobile/src/app/profile.tsx` (render `<PlayerStats />` after the Notifications section, before the note; header comment)
- Modify: `apps/mobile/src/dev/devBypass.ts` (canned `getStats`)

**Interfaces:**
- Consumes: `useApi().getStats()`; `STATS_FILTERS`, `statTiles`, `bestPartnerRecord` (`@fortytwo/client`); `colors`, `fonts` (`@/components/theme`).
- Produces: `useStats()` — `useQuery({ queryKey: ['stats'], queryFn: () => api.getStats() })`.

- [ ] **Step 1: Write the failing test** — `apps/mobile/src/components/__tests__/playerStats.test.tsx`

```tsx
import { fireEvent, render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PlayerStats as Stats, StatsSummary } from '@fortytwo/api-types';
import { PlayerStats } from '../PlayerStats';

const getStats = jest.fn();
jest.mock('@/api/useApi', () => ({ useApi: () => ({ getStats }) }));

const EMPTY: StatsSummary = {
  played: 0, won: 0, lost: 0, marksWon: 0, bidsWon: 0, bidsMade: 0, bidsSet: 0,
  averagePointsBid: null, marksBids: 0, bestPartner: null,
};

const STATS: Stats = {
  all: { ...EMPTY, played: 5, won: 3, lost: 2, bestPartner: { user: { user_id: 's', displayName: 'Sam' }, won: 3, lost: 1 } },
  humansOnly: { ...EMPTY, played: 4, won: 3, lost: 1 },
  withBots: { ...EMPTY, played: 1, won: 0, lost: 1 },
};

async function renderStats() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(
    <QueryClientProvider client={client}>
      <PlayerStats />
    </QueryClientProvider>
  );
}

afterEach(() => getStats.mockReset());

describe('PlayerStats', () => {
  it('shows All by default, with the best partner', async () => {
    getStats.mockResolvedValue(STATS);
    await renderStats();

    expect(await screen.findByText('Sam')).toBeTruthy();
    expect(screen.getByLabelText('Played: 5')).toBeTruthy();
    expect(screen.getByLabelText('Win rate: 60%')).toBeTruthy();
    expect(screen.getByText('3–1 together')).toBeTruthy();
  });

  it('switches figures with the filter', async () => {
    getStats.mockResolvedValue(STATS);
    await renderStats();
    await screen.findByText('Sam');

    fireEvent.press(screen.getByRole('radio', { name: 'With bots' }));

    expect(screen.getByLabelText('Played: 1')).toBeTruthy();
    expect(screen.queryByText('Sam')).toBeNull();
  });

  it('invites a first game when nothing is counted yet', async () => {
    getStats.mockResolvedValue({ all: EMPTY, humansOnly: EMPTY, withBots: EMPTY });
    await renderStats();
    expect(await screen.findByText('Finish a game to see your stats here.')).toBeTruthy();
  });

  it('shows an error without breaking the screen', async () => {
    getStats.mockRejectedValue(new Error('Stats are down'));
    await renderStats();
    expect(await screen.findByText('Stats are down')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -w @fortytwo/mobile -- playerStats`
Expected: FAIL — cannot find `../PlayerStats`.

- [ ] **Step 3: Implement**

`apps/mobile/src/api/useStats.ts`:

```ts
// The player's own lifetime stats (GET /api/users/stats) for the Profile. Fetched each time the
// Profile opens - unlike the profile itself, they change as games finish.
import { useQuery } from '@tanstack/react-query';
import { useApi } from './useApi';

export function useStats() {
  const api = useApi();
  return useQuery({ queryKey: ['stats'], queryFn: () => api.getStats() });
}
```

`apps/mobile/src/components/PlayerStats.tsx`:

```tsx
// The Profile's Stats section: the player's own record from completed games, filtered to All,
// Humans only or With bots, as on the web. The figures and their wording come from
// @fortytwo/client's statTiles. Loads on its own, so a failure here leaves the settings working.
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { StatsFilter } from '@fortytwo/api-types';
import { bestPartnerRecord, STATS_FILTERS, statTiles } from '@fortytwo/client';
import { useStats } from '@/api/useStats';
import { colors, fonts } from './theme';

export function PlayerStats() {
  const stats = useStats();
  const [filter, setFilter] = useState<StatsFilter>('all');
  const summary = stats.data?.[filter];

  return (
    <View style={styles.section}>
      <Text style={styles.title}>Stats</Text>

      {stats.isLoading && <ActivityIndicator color={colors.brass} />}
      {stats.error && <Text style={styles.error}>{stats.error.message}</Text>}
      {stats.data && stats.data.all.played === 0 && <Text style={styles.hint}>Finish a game to see your stats here.</Text>}

      {summary && stats.data.all.played > 0 && (
        <>
          <View style={styles.filters} accessibilityRole="radiogroup">
            {STATS_FILTERS.map(({ filter: value, label }) => {
              const selected = filter === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => setFilter(value)}
                  style={[styles.filter, selected && styles.filterSelected]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  accessibilityLabel={label}
                >
                  <Text style={[styles.filterText, selected && styles.filterTextSelected]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.grid}>
            {statTiles(summary).map(({ label, value }) => (
              <View key={label} style={styles.tile} accessible accessibilityLabel={`${label}: ${value}`}>
                <Text style={styles.value}>{value}</Text>
                <Text style={styles.label}>{label}</Text>
              </View>
            ))}
          </View>

          {summary.bestPartner && (
            <View style={styles.partner}>
              <Text style={styles.hint}>Best partner</Text>
              <Text style={styles.partnerName}>{summary.bestPartner.user.displayName}</Text>
              <Text style={styles.hint}>{bestPartnerRecord(summary.bestPartner)}</Text>
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10, padding: 14, borderRadius: 10, backgroundColor: 'rgba(20, 13, 9, 0.45)' },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 20 },
  hint: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  error: { color: colors.danger, fontFamily: fonts.ui, fontSize: 13 },
  filters: { flexDirection: 'row', gap: 6 },
  filter: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(242, 234, 219, 0.15)' },
  filterSelected: { backgroundColor: colors.brass, borderColor: colors.brass },
  filterText: { color: colors.inkMuted, fontFamily: fonts.uiBold, fontSize: 13 },
  filterTextSelected: { color: colors.walnutDeep },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { width: '31%', paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, backgroundColor: 'rgba(20, 13, 9, 0.6)' },
  value: { color: colors.bone, fontFamily: fonts.display, fontSize: 20 },
  label: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 12 },
  partner: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  partnerName: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
});
```

In `apps/mobile/src/app/profile.tsx`: `import { PlayerStats } from '@/components/PlayerStats';`, render `<PlayerStats />` after the Notifications section and before the "Your profile and settings apply on the web too." note; add a sentence to the header comment.

In `apps/mobile/src/dev/devBypass.ts`, add to `handled` (import `PlayerStats` type from `@fortytwo/api-types`):

```ts
  getStats: () =>
    answer<PlayerStats>({
      all: { played: 23, won: 14, lost: 9, marksWon: 131, bidsWon: 41, bidsMade: 30, bidsSet: 11, averagePointsBid: 32.4, marksBids: 6, bestPartner: { user: { user_id: 'gj', displayName: 'Grandma Jo' }, won: 7, lost: 2 } },
      humansOnly: { played: 15, won: 8, lost: 7, marksWon: 82, bidsWon: 26, bidsMade: 18, bidsSet: 8, averagePointsBid: 32.1, marksBids: 4, bestPartner: { user: { user_id: 'gj', displayName: 'Grandma Jo' }, won: 7, lost: 2 } },
      withBots: { played: 8, won: 6, lost: 2, marksWon: 49, bidsWon: 15, bidsMade: 12, bidsSet: 3, averagePointsBid: 33.0, marksBids: 2, bestPartner: null },
    }),
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -w @fortytwo/mobile && npm run typecheck -w @fortytwo/mobile`
Expected: PASS.

- [ ] **Step 5: Look at it** — use the `mobile-emulator` skill (dev bypass on) to open the Profile and screenshot the Stats section; check the 3-column tile grid fits and the filter row doesn't wrap awkwardly.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/api/useStats.ts apps/mobile/src/components/PlayerStats.tsx apps/mobile/src/components/__tests__/playerStats.test.tsx apps/mobile/src/app/profile.tsx apps/mobile/src/dev/devBypass.ts
git commit -m "feat(mobile): stats on the Profile"
```

---

### Task 8: Verify everything, file the follow-up, open the PR

- [ ] **Step 1: Full verification** — from `cloudflare/`: `npm test && npm run typecheck && npm run lint`. All must pass; paste failures verbatim if any.

- [ ] **Step 2: File the follow-up issue**

```bash
gh issue create --title "View another player's stats from the table or Game History" --label enhancement --label web --label mobile --label worker --body "<body>"
```

Body: follow-up to #113 — tap a seat at the table or a player in Game History to see their stats; needs `GET /api/users/:id/stats` (own-stats only today). Note on cost: reads are ~2 rows per completed game per view (player_match_stats aggregated at read time), fine for viewing your own; once anyone can view anyone's, add caching — e.g. a per-player totals row rebuilt from player_match_stats (rows stay the source of truth), or a short cache on the response.

- [ ] **Step 3: Push and open the PR** (do not merge)

```bash
git push -u origin waterfausett/player-stats
gh pr create --base master --title "feat(worker): player stats on the Profile" --body "<summary, test plan, Closes #113, follow-up link, generated-with line>"
```

If `git push` fails on TLS, retry with `git -c http.sslBackend=schannel push ...`.
