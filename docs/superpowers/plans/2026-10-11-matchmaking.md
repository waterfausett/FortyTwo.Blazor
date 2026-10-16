# Matchmaking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the lobby's Find a Game list with a New match chooser - Live (fast, bots fill
after 150 s unless a player starts them sooner, absent players go on
autopilot), Daily (waits for people) and Challenge friends
(today's create) - backed by a `Matchmaker` Durable Object, and show whose turn it is in the
Active list, with an online-player count.

**Architecture:** A single `Matchmaker` DO serializes "which open table does this player join"
and seats them at a real match right away; the waiting happens at that table. Matches gain a
`mode`. MatchDO's one alarm becomes a scheduler for bot pacing plus two Live deadlines (bot fill,
turn timeout), all computed by pure helpers in `@fortytwo/rules` so clients count down to the
same times. The Active list asks each match's MatchDO whose turn it is (no D1 writes).

**Tech Stack:** Cloudflare Workers + Durable Objects + D1, Hono, TypeScript, Vitest
(`@cloudflare/vitest-plugin` for the worker), React + TanStack Query (web), Expo/React Native +
Jest (mobile).

**Spec:** `docs/superpowers/specs/2026-10-11-matchmaking-design.md`

## Global Constraints

- Modes are exactly `'live' | 'daily' | 'custom'`; a match with no `mode` reads as `'custom'`.
- `LIVE_FILL_MS = 150_000`, `LIVE_TURN_MS = 60_000`, exported from `@fortytwo/rules`.
- Presence: one hibernatable socket per foreground app to the Matchmaker (`GET /presence/ws`); online = distinct players connected; the count is broadcast at most once per `PRESENCE_BROADCAST_MS = 60_000`. Clients never send on it.
- Bots fill seats in Live only. Daily and custom matches set no timers.
- No new D1 writes per move. The `mode` column is written only where rows are already written.
- `GET /api/matches?filter=Joinable` keeps working (installed mobile builds) but lists only `custom` tables.
- With `BOTS_ENABLED` = `'false'`, `POST /api/matchmaking { mode: 'live' }` is refused (404, like
  `POST /:id/bots`) and clients hide Live (`ClientConfig.bots`). Live tables that already exist still fill.
- Turn lookup per Active row times out after 500 ms and degrades to `turn: null`, never an error.
- Follow existing comment density: every exported function and non-obvious block gets a short "why" comment, as in `lobby.ts` and `matchDO.ts`.
- All commands below run from `cloudflare/` unless stated. Commit messages use conventional prefixes (`feat(worker):`, `feat(web):`, `feat(mobile):`, `feat(rules):`, `feat(client):`).

## Review Focus

- Bots switched off (`BOTS_ENABLED='false'`): Live must be refused by the route and hidden in clients, and an existing Live table's fill alarm must not spin - Task 7 tests the 404; Task 4 tests the alarm doesn't re-arm in a loop.
- A player on autopilot must not get a push for every turn the bot takes for them - Task 5 tests notice filtering.
- Pressing Resume after the turn clock already ran out must not put the player straight back on autopilot - Task 1 tests `resumeControl` restarts the clock; Task 5 tests it end to end.
- Someone takes a Live/Daily table's last seat outside the Matchmaker (an invite link): the Matchmaker must drop the full table and seat the next player elsewhere - Task 6 tests it.
- A burst of apps opening at once must not send a count per connect - Task 6 tests `presenceBroadcast` holds them to one alarm.
- A match DO that doesn't answer during the Active list lookup must not slow or break the lobby - Task 7 tests `withTimeout` returning null.

---

### Task 1: Rules - match modes, Live deadlines, autopilot

**Files:**
- Create: `cloudflare/packages/rules/src/live.ts`
- Create: `cloudflare/packages/rules/src/live.test.ts`
- Modify: `cloudflare/packages/rules/src/matchEngine.ts` (MatchState, `createMatch`, `createRematch`)
- Modify: `cloudflare/packages/rules/src/index.ts`

**Interfaces:**
- Produces:
  - `type MatchMode = 'live' | 'daily' | 'custom'`
  - `LIVE_FILL_MS: 150000`, `LIVE_TURN_MS: 60000`
  - `matchMode(match: Pick<MatchState, 'mode'>): MatchMode`
  - `isOnAutopilot(match: MatchState, playerId: string): boolean`
  - `isBotControlled(match: MatchState, playerId: string): boolean`
  - `interface TableWait { kind: 'turn' | 'ready'; playerIds: string[] }`, `tableWait(match: MatchState): TableWait | null`
  - `interface LiveDeadline { kind: 'fill' | 'turn'; at: number; playerIds: string[] }`, `liveDeadline(match: MatchState): LiveDeadline | null`
  - `setAutopilot(match: MatchState, playerIds: string[], on: boolean): MatchState`
  - `resumeControl(match: MatchState, playerId: string): MatchState`
  - `createMatch(firstPlayerId: string, mode?: MatchMode): MatchState` (default `'custom'`)
  - `MatchState` gains optional `mode?: MatchMode`, `searchStartedOn?: string`, `autopilot?: string[]`

- [ ] **Step 1: Write the failing tests**

`cloudflare/packages/rules/src/live.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createMatch, takeSeat, createRematch, type MatchState } from './matchEngine';
import { createDomino, type Domino } from './domino';
import { ValidationError } from './errors';
import {
  LIVE_FILL_MS,
  LIVE_TURN_MS,
  isBotControlled,
  liveDeadline,
  matchMode,
  resumeControl,
  setAutopilot,
  tableWait,
} from './live';

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// p1-p4 seated in a match of `mode`; the fourth seat deals.
function dealt(mode: 'live' | 'daily' | 'custom' = 'live'): MatchState {
  let match = createMatch('p1', mode);
  match = takeSeat(match, 'p2', 1);
  match = takeSeat(match, 'p3', 2);
  return takeSeat(match, 'p4', 3, deck());
}

describe('matchMode', () => {
  it('reads a match from before modes as custom', () => {
    const { mode: _mode, ...old } = createMatch('p1');
    expect(matchMode(old)).toBe('custom');
  });

  it('is stored on a new match, live ones with the time the search began', () => {
    const live = createMatch('p1', 'live');
    expect(live.mode).toBe('live');
    expect(live.searchStartedOn).toBe(live.createdOn);
    const daily = createMatch('p1', 'daily');
    expect(daily.mode).toBe('daily');
    expect(daily.searchStartedOn).toBeUndefined();
    expect(createMatch('p1').mode).toBe('custom');
  });

  it('carries over to a rematch', () => {
    const rematch = createRematch('r1', dealt('daily'), deck());
    expect(rematch.mode).toBe('daily');
  });
});

describe('tableWait', () => {
  it('waits on nobody before the deal', () => {
    expect(tableWait(createMatch('p1', 'live'))).toBeNull();
  });

  it('waits on whoever is to act once dealt', () => {
    expect(tableWait(dealt())).toEqual({ kind: 'turn', playerIds: ['p1'] });
  });

  it('is null once the match is won', () => {
    expect(tableWait({ ...dealt(), winningTeam: 1 })).toBeNull();
  });
});

describe('liveDeadline', () => {
  it('fills the table LIVE_FILL_MS after the search began', () => {
    const match = createMatch('p1', 'live');
    expect(liveDeadline(match)).toEqual({ kind: 'fill', at: Date.parse(match.searchStartedOn!) + LIVE_FILL_MS, playerIds: [] });
  });

  it('times the human whose turn it is from when the turn began', () => {
    const match = dealt();
    expect(liveDeadline(match)).toEqual({ kind: 'turn', at: Date.parse(match.updatedOn) + LIVE_TURN_MS, playerIds: ['p1'] });
  });

  it('sets no clock for a bot or a player on autopilot', () => {
    expect(liveDeadline(setAutopilot(dealt(), ['p1'], true))).toBeNull();
  });

  it('sets no clock outside Live', () => {
    expect(liveDeadline(dealt('daily'))).toBeNull();
    expect(liveDeadline(dealt('custom'))).toBeNull();
    expect(liveDeadline(createMatch('p1', 'daily'))).toBeNull();
  });
});

describe('autopilot', () => {
  it('counts a player on autopilot as bot-controlled, and bots always', () => {
    const match = setAutopilot(dealt(), ['p2'], true);
    expect(isBotControlled(match, 'p2')).toBe(true);
    expect(isBotControlled(match, 'p3')).toBe(false);
    expect(isBotControlled(match, 'bot-1')).toBe(true);
  });

  it('turns off without touching anyone else', () => {
    const match = setAutopilot(setAutopilot(dealt(), ['p1', 'p2'], true), ['p1'], false);
    expect(match.autopilot).toEqual(['p2']);
  });

  it('restarts the turn clock when a player resumes, so the old deadline cannot fire again', () => {
    const stale = { ...setAutopilot(dealt(), ['p1'], true), updatedOn: new Date(Date.now() - LIVE_TURN_MS * 2).toISOString() };
    const resumed = resumeControl(stale, 'p1');
    expect(resumed.autopilot).toEqual([]);
    expect(liveDeadline(resumed)!.at).toBeGreaterThan(Date.now());
  });

  it('refuses a resume from someone not at the table', () => {
    expect(() => resumeControl(dealt(), 'stranger')).toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @fortytwo/rules -- live`
Expected: FAIL - `Cannot find module './live'`.

- [ ] **Step 3: Add the fields to `MatchState` and modes to `createMatch` / `createRematch`**

In `matchEngine.ts` add `import type { MatchMode } from './live';` with the other imports, then
extend `MatchState` after `rematchId?`:

```ts
  // How the match was started: Live, Daily, or a custom table (live.ts). Absent on matches stored
  // before modes existed - read it with matchMode(), which calls those custom.
  mode?: MatchMode;
  // When a Live match began looking for players; bots take its empty seats LIVE_FILL_MS later.
  searchStartedOn?: string;
  // Players a bot is playing for, after they let a Live turn run out (live.ts).
  autopilot?: string[];
```

Change `createMatch`:

```ts
// A new match with its creator in the first seat, waiting for three more players.
export function createMatch(firstPlayerId: string, mode: MatchMode = 'custom'): MatchState {
```

and its returned object gains, after `players`:

```ts
    mode,
    ...(mode === 'live' ? { searchStartedOn: timestamp } : {}),
```

In `createRematch`'s returned object, after `players,` add:

```ts
    // The same four, playing the same way.
    ...(previous.mode !== undefined ? { mode: previous.mode } : {}),
```

- [ ] **Step 4: Write `live.ts`**

```ts
// Live play's clocks, and who a match is waiting on. Pure, like the rest of the rules: the
// Worker's MatchDO turns these deadlines into alarms, and the clients count down to the same ones.
import { isBot } from './botIds';
import { gameWinningTeam } from './game';
import { hasBeenDealt, type MatchState } from './matchEngine';
import { assertIsMatchPlayer } from './validation';

export type MatchMode = 'live' | 'daily' | 'custom';

// How long a Live table looks for people before bots take its empty seats on their own - the
// fallback for a table nobody is watching. Players usually press Start now with bots sooner.
export const LIVE_FILL_MS = 150_000;
// How long a Live turn waits on a human before a bot plays it for them.
export const LIVE_TURN_MS = 60_000;

export function matchMode(match: Pick<MatchState, 'mode'>): MatchMode {
  return match.mode ?? 'custom';
}

export function isOnAutopilot(match: MatchState, playerId: string): boolean {
  return match.autopilot?.includes(playerId) ?? false;
}

// Whether a bot makes this seat's moves: a bot's own, or a player's while they're on autopilot.
export function isBotControlled(match: MatchState, playerId: string): boolean {
  return isBot(playerId) || isOnAutopilot(match, playerId);
}

// Who the table is waiting on: the player to act, or - once the hand is decided - everyone still
// to ready up. Null before the deal and after the match is won.
export interface TableWait {
  kind: 'turn' | 'ready';
  playerIds: string[];
}

export function tableWait(match: MatchState): TableWait | null {
  if (match.winningTeam !== null || match.players.length < 4 || !hasBeenDealt(match)) return null;
  if (gameWinningTeam(match.currentGame) !== null) {
    return { kind: 'ready', playerIds: match.players.filter((p) => !p.ready).map((p) => p.playerId) };
  }
  const current = match.currentGame.currentPlayerId;
  return current === null ? null : { kind: 'turn', playerIds: [current] };
}

// The next thing a Live match does on its own, and when: fill its empty seats with bots, or put
// the humans it's waiting on onto autopilot. Mid-hand only the player to act can change the
// match, so `updatedOn` is when their turn began.
export interface LiveDeadline {
  kind: 'fill' | 'turn';
  at: number;
  playerIds: string[];
}

export function liveDeadline(match: MatchState): LiveDeadline | null {
  if (matchMode(match) !== 'live' || match.winningTeam !== null) return null;
  if (match.players.length < 4) {
    return match.searchStartedOn === undefined
      ? null
      : { kind: 'fill', at: Date.parse(match.searchStartedOn) + LIVE_FILL_MS, playerIds: [] };
  }
  const humans = tableWait(match)?.playerIds.filter((id) => !isBotControlled(match, id)) ?? [];
  if (humans.length === 0) return null;
  return { kind: 'turn', at: Date.parse(match.updatedOn) + LIVE_TURN_MS, playerIds: humans };
}

export function setAutopilot(match: MatchState, playerIds: string[], on: boolean): MatchState {
  const ids = new Set(match.autopilot ?? []);
  for (const id of playerIds) {
    if (on) ids.add(id);
    else ids.delete(id);
  }
  return { ...match, autopilot: [...ids] };
}

// A player taking their seat back from the bot. Their clock starts over, or the deadline that put
// them on autopilot - already past - would put them straight back on it.
export function resumeControl(match: MatchState, playerId: string): MatchState {
  assertIsMatchPlayer(match, playerId);
  return { ...setAutopilot(match, [playerId], false), updatedOn: new Date().toISOString() };
}
```

In `index.ts` add after the `matchEngine` exports:

```ts
export type { MatchMode, TableWait, LiveDeadline } from './live';
export {
  LIVE_FILL_MS,
  LIVE_TURN_MS,
  matchMode,
  isOnAutopilot,
  isBotControlled,
  tableWait,
  liveDeadline,
  setAutopilot,
  resumeControl,
} from './live';
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -w @fortytwo/rules && npm run typecheck -w @fortytwo/rules`
Expected: PASS, no type errors. (If `assertIsMatchPlayer`'s signature takes a `MatchLike`, a
`MatchState` satisfies it.)

- [ ] **Step 6: Commit**

```bash
git add cloudflare/packages/rules
git commit -m "feat(rules): match modes, Live deadlines and autopilot"
```

---

### Task 2: Worker bots act for players on autopilot

**Files:**
- Modify: `cloudflare/apps/worker/src/bots.ts:66-96` (`findNextBotAction`)
- Test: `cloudflare/apps/worker/src/bots.test.ts`

**Interfaces:**
- Consumes: `isBotControlled`, `setAutopilot` from `@fortytwo/rules` (Task 1)
- Produces: `findNextBotAction(match)` returns actions for autopilot players too (same signature)

- [ ] **Step 1: Write the failing tests** (append inside the file, using its `baseMatch`/`baseGame`/`emptyHand` helpers)

```ts
describe('findNextBotAction with autopilot', () => {
  it("acts for a human on autopilot when it's their turn", () => {
    const match = setAutopilot(
      baseMatch({ currentGame: baseGame({ currentPlayerId: 'p1', hands: [emptyHand('p1')] }) }),
      ['p1'],
      true
    );
    expect(findNextBotAction(match)).toEqual({ kind: 'bid', playerId: 'p1' });
  });

  it('leaves a human alone once they are off autopilot', () => {
    const match = baseMatch({ currentGame: baseGame({ currentPlayerId: 'p1', hands: [emptyHand('p1')] }) });
    expect(findNextBotAction(match)).toBeNull();
  });
});
```

Add `setAutopilot` to the file's `@fortytwo/rules` import. If `baseMatch`'s default players or
hands make `p1` ineligible to bid, pass the minimum overrides the existing bid tests in this file
use for a bot (copy that test's fixture and swap the bot id for `'p1'`).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @fortytwo/worker -- bots.test`
Expected: FAIL - first test gets `null`.

- [ ] **Step 3: Implement**

In `bots.ts`, import `isBotControlled` from `@fortytwo/rules` and replace the three `isBot(...)`
checks in `findNextBotAction`:

```ts
    const waitingBot = match.players.find((p) => isBotControlled(match, p.playerId) && !p.ready);
```
```ts
    return currentPlayerId !== null && isBotControlled(match, currentPlayerId) && (hand?.dominoes.length ?? 0) > 0
```
```ts
  if (currentPlayerId === null || !isBotControlled(match, currentPlayerId)) return null;
```

Update the function's comment: "...the single next action a bot takes - for a bot's own seat, or
for a player on autopilot (live.ts) - or null if...".

- [ ] **Step 4: Run tests**

Run: `npm test -w @fortytwo/worker -- bots`
Expected: PASS (including the existing `matchDOBots` tests).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/apps/worker/src/bots.ts cloudflare/apps/worker/src/bots.test.ts
git commit -m "feat(worker): bots play for players on autopilot"
```

---

### Task 3: Lobby index records each match's mode

**Files:**
- Create: `cloudflare/apps/worker/migrations/0010_matches_mode.sql`
- Modify: `cloudflare/apps/worker/src/lobby.ts`
- Modify: `cloudflare/packages/api-types/src/index.ts` (`MatchMode`, `TurnSummary`, `MatchSummary`)
- Test: `cloudflare/apps/worker/test/lobby.test.ts`

**Interfaces:**
- Consumes: `matchMode` (Task 1)
- Produces:
  - api-types: `type MatchMode = 'live' | 'daily' | 'custom'`; `interface TurnSummary { kind: 'turn' | 'ready'; yours: boolean; waitingOn: string[] }`; `MatchSummary` gains `mode: MatchMode` and `turn?: TurnSummary | null`
  - lobby: `MatchIndexRow = Omit<MatchSummary, 'teams' | 'seats' | 'turn' | 'mode'> & { mode?: MatchMode | null }`; `listActive` hides undealt Live; `listJoinable` lists only custom; rows carry `mode`

- [ ] **Step 1: Write the failing tests** (in `lobby.test.ts`)

```ts
describe('modes', () => {
  it('hides a Live table still looking for players from Active, and shows it once full', async () => {
    await upsertMatchSummary(testEnv.DB, { id: 'live-searching', status: 'active', playerCount: 2, updatedOn: '2026-09-24T01:00:00Z', mode: 'live' });
    await syncMatchPlayers(testEnv.DB, 'live-searching', seat('p1', 'p2'));
    await upsertMatchSummary(testEnv.DB, { id: 'live-full', status: 'active', playerCount: 4, updatedOn: '2026-09-24T02:00:00Z', mode: 'live' });
    await syncMatchPlayers(testEnv.DB, 'live-full', seat('p1', 'p2', 'p3', 'p4'));
    await upsertMatchSummary(testEnv.DB, { id: 'daily-filling', status: 'active', playerCount: 1, updatedOn: '2026-09-24T03:00:00Z', mode: 'daily' });
    await syncMatchPlayers(testEnv.DB, 'daily-filling', seat('p1'));

    const { rows } = await listActive(testEnv.DB, 'p1');

    expect(rows.map((r) => [r.id, r.mode])).toEqual([
      ['daily-filling', 'daily'],
      ['live-full', 'live'],
    ]);
  });

  it('lists only custom tables as joinable, counting a match with no mode as custom', async () => {
    await upsertMatchSummary(testEnv.DB, { id: 'old', status: 'active', playerCount: 1, updatedOn: '2026-09-24T01:00:00Z' });
    await upsertMatchSummary(testEnv.DB, { id: 'custom', status: 'active', playerCount: 1, updatedOn: '2026-09-24T02:00:00Z', mode: 'custom' });
    await upsertMatchSummary(testEnv.DB, { id: 'daily', status: 'active', playerCount: 1, updatedOn: '2026-09-24T03:00:00Z', mode: 'daily' });

    const { rows } = await listJoinable(testEnv.DB, 'someone-else');

    expect(rows.map((r) => r.id)).toEqual(['custom', 'old']);
  });

  it("keeps a row's mode when a later upsert doesn't name one", async () => {
    await upsertMatchSummary(testEnv.DB, { id: 'm', status: 'active', playerCount: 1, updatedOn: '2026-09-24T01:00:00Z', mode: 'daily' });
    await upsertMatchSummary(testEnv.DB, { id: 'm', status: 'active', playerCount: 2, updatedOn: '2026-09-24T02:00:00Z' });
    const row = await testEnv.DB.prepare('SELECT mode FROM matches WHERE id = ?').bind('m').first<{ mode: string }>();
    expect(row?.mode).toBe('daily');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @fortytwo/worker -- lobby.test`
Expected: FAIL - type error / `no such column: mode`.

- [ ] **Step 3: Migration**

`cloudflare/apps/worker/migrations/0010_matches_mode.sql`:

```sql
-- How each match was started: 'live', 'daily' or 'custom'. Null on rows from before modes, which
-- read as 'custom'. Set when the row is first written and never changed after, so it costs no
-- extra writes.
ALTER TABLE matches ADD COLUMN mode TEXT;
```

- [ ] **Step 4: api-types**

In `cloudflare/packages/api-types/src/index.ts`, after `MatchStatus`:

```ts
// How a match was started (the rules package's MatchMode, repeated here since this package
// carries no runtime dependencies).
export type MatchMode = 'live' | 'daily' | 'custom';

// Who an Active match is waiting on, looked up from the match itself when the list loads:
// `kind` is a turn (one player) or a ready-up between hands (everyone not yet ready);
// `waitingOn` are display names; `yours` says whether the viewer is among them.
export interface TurnSummary {
  kind: 'turn' | 'ready';
  yours: boolean;
  waitingOn: string[];
}
```

and in `MatchSummary` add:

```ts
  mode: MatchMode;
  // Active list only; null when the match couldn't say in time (the row shows without it).
  turn?: TurnSummary | null;
```

- [ ] **Step 5: lobby.ts**

- `MatchIndexRow`:

```ts
// One row of the `matches` table. GET /api/matches adds each match's teams, seats and (for
// Active) turn to make the full MatchSummary, and reads a null mode as 'custom'.
export type MatchIndexRow = Omit<MatchSummary, 'teams' | 'seats' | 'turn' | 'mode'> & { mode?: MatchMode | null };
```

(import `MatchMode` type from `@fortytwo/api-types`, and `matchMode` from `@fortytwo/rules`.)

- `syncLobbyIndex` passes `mode: matchMode(match)` to `upsertMatchSummary`.
- `upsertMatchSummary`:

```ts
    .prepare(
      `INSERT INTO matches (id, status, player_count, updated_on, mode) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, player_count = excluded.player_count,
         updated_on = excluded.updated_on, mode = COALESCE(excluded.mode, matches.mode)`
    )
    .bind(summary.id, summary.status, summary.playerCount, summary.updatedOn, summary.mode ?? null)
```

- `refreshMatchSummary`'s INSERT OR IGNORE:

```ts
      .prepare('INSERT OR IGNORE INTO matches (id, status, player_count, updated_on, mode) VALUES (?, ?, ?, ?, ?)')
      .bind(match.id, status, match.players.length, match.updatedOn, matchMode(match)),
```

- `listForPlayer` selects `m.mode` and, for `'active'`, hides undealt Live:

```ts
      `SELECT m.id, m.status, m.player_count AS playerCount, m.updated_on AS updatedOn, m.mode
       FROM matches m JOIN match_players mp ON mp.match_id = m.id
       WHERE mp.player_id = ?1 AND m.status = ?2
       -- A Live table still looking for players is a search, shown on its match page, not a game.
       AND NOT (COALESCE(m.mode, 'custom') = 'live' AND m.player_count < 4)
       AND (?3 IS NULL OR (m.updated_on, m.id) < (?3, ?4))
       ORDER BY m.updated_on DESC, m.id DESC LIMIT ?5`
```

- `listJoinable` selects `mode` and adds `AND COALESCE(mode, 'custom') = 'custom'`; update its
  comment: "Open custom tables. Current clients no longer list these; installed mobile builds
  from before matchmaking still do."

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -w @fortytwo/worker -- lobby && npm run typecheck -w @fortytwo/worker`
Expected: lobby tests PASS. Typecheck will flag `routes/matches.ts` building `MatchSummary`
without `mode`: add `mode: row.mode ?? 'custom'` to the object built there
(`return { ...row, mode: row.mode ?? 'custom', teams: [...], seats };`). Re-run until clean.

- [ ] **Step 7: Commit**

```bash
git add cloudflare/apps/worker cloudflare/packages/api-types
git commit -m "feat(worker): record each match's mode in the lobby index"
```

---

### Task 4: MatchDO - modes, alarm scheduler, Live bot fill

**Files:**
- Modify: `cloudflare/apps/worker/src/matchDO.ts`
- Create: `cloudflare/apps/worker/test/matchDOLive.test.ts`

**Interfaces:**
- Consumes: `liveDeadline`, `createMatch(firstPlayerId, mode)` (Task 1); `findNextBotAction` (Task 2); `syncLobbyIndex` (Task 3)
- Produces: `MatchDO.create(firstPlayerId: string, matchId: string, mode?: MatchMode): Promise<MatchState>`; private `schedule(match)` replacing `scheduleBotsIfNeeded`; private `seatBots(match, positions?)`

- [ ] **Step 1: Write the failing tests**

`cloudflare/apps/worker/test/matchDOLive.test.ts`:

```ts
// Live matches' own clock (live.ts's liveDeadline, run by MatchDO's alarm): bots take a Live
// table's empty seats LIVE_FILL_MS after it began looking, and nothing of the sort happens to Daily
// or custom tables. Deadlines are reached by winding the stored match's times back, as
// matchDOPoke.test.ts does, then firing the alarm.
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { LIVE_FILL_MS, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';

const testEnv = env as unknown as Env;

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}
type Stub = ReturnType<typeof stubFor>;

async function stored(stub: Stub): Promise<MatchState> {
  return runInDurableObject(stub, async (_instance, state) => (await state.storage.get<MatchState>('match'))!);
}

async function windBack(stub: Stub, change: (match: MatchState) => Partial<MatchState>): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const match = (await state.storage.get<MatchState>('match'))!;
    await state.storage.put('match', { ...match, ...change(match) });
  });
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe('Live bot fill', () => {
  it('stores the mode it was created with', async () => {
    const stub = stubFor('live-mode');
    const match = await stub.create('p1', 'live-mode', 'live');
    expect(match.mode).toBe('live');
    expect(match.searchStartedOn).toEqual(expect.any(String));
  });

  it('arms an alarm for the fill as soon as a Live table is created', async () => {
    const stub = stubFor('live-armed');
    await stub.create('p1', 'live-armed', 'live');
    const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(alarm).toEqual(expect.any(Number));
  });

  it('does nothing when the alarm fires before the deadline', async () => {
    const stub = stubFor('live-early');
    await stub.create('p1', 'live-early', 'live');
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).players).toHaveLength(1);
  });

  it('fills the empty seats with bots once the deadline passes, and deals', async () => {
    const stub = stubFor('live-fill');
    await stub.create('p1', 'live-fill', 'live');
    await stub.takeSeat('p2', 2);
    await windBack(stub, () => ({ searchStartedOn: ago(LIVE_FILL_MS + 1000) }));

    await runDurableObjectAlarm(stub);

    const match = await stored(stub);
    expect(match.players.map((p) => p.playerId).sort()).toEqual(['bot-1', 'bot-2', 'p1', 'p2']);
    expect(match.currentGame.hands.every((h) => h.dominoes.length === 7)).toBe(true);
    const row = await testEnv.DB.prepare('SELECT player_count FROM matches WHERE id = ?').bind('live-fill').first<{ player_count: number }>();
    expect(row?.player_count).toBe(4);
  });

  it('never fills a Daily or custom table', async () => {
    for (const mode of ['daily', 'custom'] as const) {
      const name = `no-fill-${mode}`;
      const stub = stubFor(name);
      await stub.create('p1', name, mode);
      await windBack(stub, () => ({ createdOn: ago(LIVE_FILL_MS * 10), updatedOn: ago(LIVE_FILL_MS * 10) }));
      expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();
    }
  });

  it('leaves no alarm behind once a cancelled search deletes the match', async () => {
    const stub = stubFor('live-cancel');
    await stub.create('p1', 'live-cancel', 'live');
    await stub.leave('p1');
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @fortytwo/worker -- matchDOLive`
Expected: FAIL - `create` ignores the mode; no alarm.

- [ ] **Step 3: Implement in `matchDO.ts`**

Imports: add `liveDeadline`, `setAutopilot` and `type MatchMode` from
`@fortytwo/rules`; `syncLobbyIndex` is already imported.

`create`:

```ts
  async create(firstPlayerId: string, matchId: string, mode: MatchMode = 'custom'): Promise<MatchState> {
    const match = { ...createMatch(firstPlayerId, mode), id: matchId };
    await this.save(match);
    this.publish(null, match);
    // A Live table's fill deadline starts now.
    await this.schedule(match);
    return match;
  }
```

Extract the seat-filling from `addBots`:

```ts
  addBots(requesterId: string, positions?: number[]): Promise<MatchResult<MatchState>> {
    return this.update(requesterId, (match) => {
      assertIsMatchPlayer(match, requesterId);
      return seatBots(match, positions);
    });
  }
```

and at the bottom of the file (module scope, next to `matchMessageFor`):

```ts
// Seats a bot at each of `positions`, or at every open seat when none are given. Each bot takes
// the first reserved id not yet seated; the fourth seat deals.
function seatBots(match: MatchState, positions?: number[]): MatchState {
  const seats = positions ?? [0, 1, 2, 3].filter((position) => match.players.every((p) => p.position !== position));
  let next = match;
  for (const position of seats) {
    const botId = BOT_IDS.find((id) => next.players.every((p) => p.playerId !== id))!;
    next = takeSeat(next, botId, position, shuffledDominoOrder());
  }
  return next;
}
```

Rename `scheduleBotsIfNeeded` to `schedule` at every call site (`createRematch` x2, `leave`,
`update`, `alarm`) and replace its body:

```ts
  // Sets the alarm for whatever this match does next on its own: a bot's move a beat from now
  // (paced like a remote player's, bots.ts's botDelayMs), or a Live deadline (live.ts) - filling
  // the table, or a turn running out. One alarm serves all of them; alarm() works out which is due.
  private async schedule(match: MatchState): Promise<void> {
    const action = findNextBotAction(match);
    if (action !== null) {
      await this.ctx.storage.setAlarm(Date.now() + botDelayMs(match, action));
      return;
    }
    const deadline = liveDeadline(match);
    if (deadline !== null) await this.ctx.storage.setAlarm(Math.max(deadline.at, Date.now()));
  }
```

In `alarm()`, replace from `const action = findNextBotAction(match);` to the end with:

```ts
    const action = findNextBotAction(match);
    if (action !== null) {
      const next = applyBotAction(match, action, bot);
      await this.save(next);
      // Scheduled straight after the save: the saved match already points at the next bot action,
      // so if anything below threw first, the runtime's retry would fire that action unpaced, and
      // once its retries ran out a match waiting on a bot would be stuck.
      await this.schedule(next);
      this.publish(match, next);
      if (action.kind === 'ready' || action.kind === 'play') {
        await bestEffort(next.id, () => refreshMatchSummary(this.env.DB, next));
      }
      return;
    }

    const deadline = liveDeadline(match);
    if (deadline === null) return;
    // Fired early - the alarm was set for something that has since changed: wait for the deadline.
    if (Date.now() < deadline.at) {
      await this.schedule(match);
      return;
    }
    const next = deadline.kind === 'fill' ? seatBots(match) : setAutopilot(match, deadline.playerIds, true);
    await this.save(next);
    await this.schedule(next);
    this.publish(match, next);
    // Filling changes who's seated, which the lobby lists; going on autopilot doesn't.
    if (deadline.kind === 'fill') await bestEffort(next.id, () => syncLobbyIndex(this.env.DB, next));
```

(`setAutopilot` comes from `@fortytwo/rules`; the `'turn'` branch is exercised in Task 5.)

Update `alarm()`'s leading comment: "Runs one thing per firing: the next bot move, or a Live
deadline that has come due (live.ts). Alarm-driven changes never pass through routes/matches.ts,
which syncs the D1 lobby index for everything else, so it's synced here...".

- [ ] **Step 4: Run tests**

Run: `npm test -w @fortytwo/worker`
Expected: PASS - new file plus all existing MatchDO tests (bot pacing unchanged).

- [ ] **Step 5: Commit**

```bash
git add cloudflare/apps/worker/src/matchDO.ts cloudflare/apps/worker/test/matchDOLive.test.ts
git commit -m "feat(worker): Live tables fill with bots when the search runs out"
```

---

### Task 5: MatchDO - turn timeout, autopilot, resume, getTurn

**Files:**
- Modify: `cloudflare/apps/worker/src/matchDO.ts`
- Modify: `cloudflare/apps/worker/test/matchDOLive.test.ts`

**Interfaces:**
- Consumes: `setAutopilot`, `isOnAutopilot`, `resumeControl`, `tableWait`, `LIVE_TURN_MS`, `type TableWait` (Task 1)
- Produces: `MatchDO.resume(playerId: string): Promise<MatchResult<MatchState>>`; `MatchDO.getTurn(): Promise<MatchResult<TableWait | null>>`

- [ ] **Step 1: Write the failing tests** (append to `matchDOLive.test.ts`; add `LIVE_TURN_MS`, `createDomino`, `type Domino` to the rules import)

```ts
function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

async function dealtLive(name: string): Promise<Stub> {
  const stub = stubFor(name);
  await stub.create('p1', name, 'live');
  await stub.takeSeat('p2', 1);
  await stub.takeSeat('p3', 2);
  await stub.takeSeat('p4', 3, deck());
  return stub;
}

describe('Live turn timeout', () => {
  it('leaves the player alone before their minute is up', async () => {
    const stub = await dealtLive('turn-early');
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).autopilot ?? []).toEqual([]);
  });

  it('puts the player on autopilot when their turn runs out, and a bot then moves for them', async () => {
    const stub = await dealtLive('turn-timeout');
    const turn = (await stored(stub)).currentGame.currentPlayerId!;
    await windBack(stub, () => ({ updatedOn: ago(LIVE_TURN_MS + 1000) }));

    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).autopilot).toEqual([turn]);

    await runDurableObjectAlarm(stub);
    const after = await stored(stub);
    expect(after.currentGame.hands.find((h) => h.playerId === turn)!.bid).not.toBeNull();
  });

  it('takes a player off autopilot when they act', async () => {
    const stub = await dealtLive('turn-act');
    await windBack(stub, (m) => ({ autopilot: [m.currentGame.currentPlayerId!] }));
    const turn = (await stored(stub)).currentGame.currentPlayerId!;
    // A pass is always legal unless forced; the first bidder is never forced.
    const result = await stub.bid(turn, 0);
    expect(result.ok).toBe(true);
    expect((await stored(stub)).autopilot).toEqual([]);
  });

  it('lets a player resume without acting, and their clock starts over', async () => {
    const stub = await dealtLive('turn-resume');
    const turn = (await stored(stub)).currentGame.currentPlayerId!;
    await windBack(stub, () => ({ autopilot: [turn], updatedOn: ago(LIVE_TURN_MS * 3) }));

    const result = await stub.resume(turn);

    expect(result.ok).toBe(true);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).autopilot).toEqual([]);
  });
});

describe('getTurn', () => {
  it('says whose turn it is', async () => {
    const stub = await dealtLive('get-turn');
    const turn = (await stored(stub)).currentGame.currentPlayerId!;
    expect(await stub.getTurn()).toEqual({ ok: true, value: { kind: 'turn', playerIds: [turn] } });
  });

  it('is null while the table is filling', async () => {
    const stub = stubFor('get-turn-filling');
    await stub.create('p1', 'get-turn-filling', 'daily');
    expect(await stub.getTurn()).toEqual({ ok: true, value: null });
  });
});
```

Push filtering is pinned through a pure function `matchDO.ts` exports (Step 3):

```ts
import { noticesFor } from '../src/matchDO';
import { pushNotices } from '../src/push/notices';

describe('noticesFor', () => {
  it("drops a turn notice for a player on autopilot, and keeps everyone else's", async () => {
    const stub = await dealtLive('quiet-notices');
    const before = await stored(stub);
    const turn = before.currentGame.currentPlayerId!;
    const next = { ...before, autopilot: [turn] };
    // The deal itself produced notices; recompute them as if from an undealt table.
    const undealt = { ...before, currentGame: { ...before.currentGame, hands: before.currentGame.hands.map((h) => ({ ...h, dominoes: [] })) } };
    const all = pushNotices(undealt, next);
    const kept = noticesFor(undealt, next, new Set());
    expect(all.some((n) => n.playerId === turn)).toBe(true);
    expect(kept.some((n) => n.playerId === turn)).toBe(false);
    expect(kept.length).toBe(all.length - all.filter((n) => n.playerId === turn).length);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @fortytwo/worker -- matchDOLive`
Expected: FAIL - `stub.resume` / `stub.getTurn` / `noticesFor` don't exist.

- [ ] **Step 3: Implement**

Imports from `@fortytwo/rules`: add `isOnAutopilot`, `resumeControl`, `setAutopilot`, `tableWait`,
`type TableWait`. Import `type Notice` from `./push/notices`.

In `update`, clear the actor's autopilot:

```ts
    return this.read(async (match) => {
      const acted = await action(match);
      // Acting is taking your seat back from the bot (live.ts).
      const next = isOnAutopilot(acted, actorId) ? setAutopilot(acted, [actorId], false) : acted;
      await this.save(next);
      this.publish(match, next, [actorId]);
      await this.schedule(next);
      return next;
    });
```

New RPC methods, after `playDomino`:

```ts
  // A player back at a Live table taking their seat back from the bot before their next turn.
  resume(playerId: string): Promise<MatchResult<MatchState>> {
    return this.update(playerId, (match) => resumeControl(match, playerId));
  }

  // Who the table is waiting on, for the lobby's Active list. A read of what this DO already
  // holds, so the list never needs D1 to keep a turn column up to date.
  getTurn(): Promise<MatchResult<TableWait | null>> {
    return this.read((match) => tableWait(match));
  }
```

In `publish`, replace the `notices` line:

```ts
    const notices = noticesFor(previous, next, watching);
```

and add at module scope:

```ts
// What to push after a change: pushNotices' list, less anyone watching the match, and less anyone
// on autopilot - a bot is taking their turns, so a push per turn would only nag. The end of the
// match still reaches them.
export function noticesFor(previous: MatchState | null, next: MatchState, watching: Set<string>): Notice[] {
  return pushNotices(previous, next).filter(
    (n) => !watching.has(n.playerId) && (n.kind === 'matchOver' || !isOnAutopilot(next, n.playerId))
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -w @fortytwo/worker && npm run typecheck -w @fortytwo/worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare/apps/worker/src/matchDO.ts cloudflare/apps/worker/test/matchDOLive.test.ts
git commit -m "feat(worker): Live turns time out to autopilot; resume and getTurn"
```

---

### Task 6: Matchmaker Durable Object

**Files:**
- Create: `cloudflare/apps/worker/src/matchmaker.ts`
- Create: `cloudflare/apps/worker/test/matchmaker.test.ts`
- Create: `cloudflare/apps/worker/test/matchmakerPresence.test.ts`
- Modify: `cloudflare/apps/worker/wrangler.toml`
- Modify: `cloudflare/apps/worker/src/index.ts` (Env binding, export)

**Interfaces:**
- Consumes: `MatchDO.create(firstPlayerId, matchId, mode)`, `MatchDO.getMatch()`, `MatchDO.takeSeat(...)` (Task 4)
- Produces: `type QueueMode = 'live' | 'daily'`; `class Matchmaker` with `play(playerId: string, mode: QueueMode): Promise<MatchState>`, a WebSocket upgrade at `fetch('/presence/ws?token=')`, and `alarm()`; `PRESENCE_BROADCAST_MS = 60_000`; `presenceBroadcast(now: number, lastSentAt: number | null, alarmAt: number | null): { kind: 'now' } | { kind: 'alarm'; at: number } | { kind: 'wait' }`; `Env.MATCHMAKER: DurableObjectNamespace<Matchmaker>`; api-types `interface PresenceMessage { type: 'online'; online: number }`

- [ ] **Step 1: Wire the binding** (needed before the test can run)

`wrangler.toml`, after the MATCH_DO binding and the v1 migration:

```toml
[[durable_objects.bindings]]
name = "MATCHMAKER"
class_name = "Matchmaker"
```

and after the existing `[[migrations]]` block:

```toml
[[migrations]]
tag = "v2"
new_sqlite_classes = ["Matchmaker"]
```

`index.ts`: add to `Env`

```ts
  // The one Matchmaker (matchmaker.ts), addressed by name 'global', that seats Live and Daily players.
  MATCHMAKER: DurableObjectNamespace<Matchmaker>;
```

with `import type { Matchmaker } from './matchmaker';`, and at the bottom
`export { Matchmaker } from './matchmaker';`.

- [ ] **Step 2: Write the failing tests**

`cloudflare/apps/worker/test/matchmaker.test.ts`:

```ts
// The Matchmaker: seats a player at the oldest open table of their mode, or starts one, and never
// splits players who press Play together across two tables. Each test uses its own instance.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createDomino, type Domino } from '@fortytwo/rules';
import type { Env } from '../src/index';
import { PRESENCE_BROADCAST_MS, presenceBroadcast } from '../src/matchmaker';

const testEnv = env as unknown as Env;

function matchmaker(name: string) {
  return testEnv.MATCHMAKER.get(testEnv.MATCHMAKER.idFromName(name));
}
function matchStub(id: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(id));
}
function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

describe('Matchmaker', () => {
  it('starts a table for the first player and seats the next one at it', async () => {
    const mm = matchmaker('mm-basic');
    const first = await mm.play('a', 'daily');
    const second = await mm.play('b', 'daily');

    expect(first.mode).toBe('daily');
    expect(second.id).toBe(first.id);
    expect(second.players.map((p) => p.playerId).sort()).toEqual(['a', 'b']);
  });

  it('puts two players who press Play at once at the same table', async () => {
    const mm = matchmaker('mm-race');
    const [a, b] = await Promise.all([mm.play('a', 'live'), mm.play('b', 'live')]);
    expect(a.id).toBe(b.id);
  });

  it('keeps Live and Daily tables apart', async () => {
    const mm = matchmaker('mm-modes');
    const live = await mm.play('a', 'live');
    const daily = await mm.play('b', 'daily');
    expect(daily.id).not.toBe(live.id);
  });

  it('returns your current Live search instead of starting a second one', async () => {
    const mm = matchmaker('mm-live-again');
    const first = await mm.play('a', 'live');
    const again = await mm.play('a', 'live');
    expect(again.id).toBe(first.id);
    expect(again.players).toHaveLength(1);
  });

  it('lets one player wait at several Daily tables', async () => {
    const mm = matchmaker('mm-daily-several');
    const first = await mm.play('a', 'daily');
    const second = await mm.play('a', 'daily');
    expect(second.id).not.toBe(first.id);
  });

  it('moves on from a table filled outside matchmaking (an invite link)', async () => {
    const mm = matchmaker('mm-filled-elsewhere');
    const table = await mm.play('a', 'daily');
    const stub = matchStub(table.id);
    await stub.takeSeat('x', 1);
    await stub.takeSeat('y', 2);
    await stub.takeSeat('z', 3, deck());

    const next = await mm.play('b', 'daily');

    expect(next.id).not.toBe(table.id);
    expect(next.players.map((p) => p.playerId)).toEqual(['b']);
  });

  it('moves on from a table deleted when its last player left', async () => {
    const mm = matchmaker('mm-deleted');
    const table = await mm.play('a', 'daily');
    await matchStub(table.id).leave('a');

    const next = await mm.play('b', 'daily');

    expect(next.id).not.toBe(table.id);
  });
});

describe('presenceBroadcast', () => {
  const t = 1_000_000;

  it('sends at once when nothing has gone out in the last minute', () => {
    expect(presenceBroadcast(t, null, null)).toEqual({ kind: 'now' });
    expect(presenceBroadcast(t, t - PRESENCE_BROADCAST_MS, null)).toEqual({ kind: 'now' });
  });

  it('holds a change inside the minute for one alarm when the minute is up', () => {
    expect(presenceBroadcast(t, t - 10_000, null)).toEqual({ kind: 'alarm', at: t - 10_000 + PRESENCE_BROADCAST_MS });
  });

  it('adds nothing when that alarm is already set', () => {
    expect(presenceBroadcast(t, t - 10_000, t + 50_000)).toEqual({ kind: 'wait' });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -w @fortytwo/worker -- matchmaker`
Expected: FAIL - `Cannot find module '../src/matchmaker'` / no class `Matchmaker`.

- [ ] **Step 4: Implement `matchmaker.ts`**

```ts
// The Matchmaker: one Durable Object (addressed by name 'global') that answers "which table does
// this player sit at?" for Live and Daily play. It keeps, per mode, the ids of tables still
// looking for players, oldest first, and seats the player at the first that takes them - or
// starts a new one. The waiting itself happens at that table (MatchDO): its socket shows the
// seats filling, and a Live one fills with bots on its own clock (live.ts).
//
// It never hears from matches. A table that filled (through here, an invite link, or bots) or was
// deleted is found out when it refuses the next seat, and dropped then.
import { DurableObject } from 'cloudflare:workers';
import { hasBeenDealt, shuffledDominoOrder, type MatchState } from '@fortytwo/rules';
import type { Env } from './index';

export type QueueMode = 'live' | 'daily';

export class Matchmaker extends DurableObject<Env> {
  // Plays run one at a time. DO input gates don't hold while this awaits a MatchDO call, so two
  // plays left to interleave could each find no open table and start one apiece.
  private queue: Promise<unknown> = Promise.resolve();

  play(playerId: string, mode: QueueMode): Promise<MatchState> {
    const turn = this.queue.then(() => this.seat(playerId, mode));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async seat(playerId: string, mode: QueueMode): Promise<MatchState> {
    const key = `open:${mode}`;
    const open = (await this.ctx.storage.get<string[]>(key)) ?? [];
    const stillOpen: string[] = [];
    let seated: MatchState | null = null;

    for (const id of open) {
      if (seated !== null) {
        stillOpen.push(id);
        continue;
      }
      const table = this.matchStub(id);
      const found = await table.getMatch();
      // Gone, full or under way: no longer looking for players.
      if (!found.ok || found.value.players.length >= 4 || hasBeenDealt(found.value)) continue;
      const match = found.value;

      if (match.players.some((p) => p.playerId === playerId)) {
        stillOpen.push(id);
        // One Live search at a time: hand back the one already running. Daily players may wait at
        // several tables, so look further.
        if (mode === 'live') seated = match;
        continue;
      }

      const seatAt = [0, 1, 2, 3].find((position) => match.players.every((p) => p.position !== position))!;
      const joined = await table.takeSeat(playerId, seatAt, shuffledDominoOrder());
      if (!joined.ok) {
        // A 404 is a deleted table; anything else (a seat taken a moment ago) may still have room.
        if (joined.status !== 404) stillOpen.push(id);
        continue;
      }
      seated = joined.value;
      if (seated.players.length < 4) stillOpen.push(id);
    }

    if (seated === null) {
      const id = crypto.randomUUID();
      seated = await this.matchStub(id).create(playerId, id, mode);
      stillOpen.push(id);
    }
    await this.ctx.storage.put(key, stillOpen);
    return seated;
  }

  private matchStub(id: string) {
    return this.env.MATCH_DO.get(this.env.MATCH_DO.idFromName(id));
  }
}
```

Then add presence - the online count - to the same class. Imports: `verifyToken` from
`./auth/verifyJwt`, `type PresenceMessage` from `@fortytwo/api-types`.

```ts
// How often, at most, the online count goes out to every presence socket.
export const PRESENCE_BROADCAST_MS = 60_000;

// When to send a changed online count: now, if nothing has gone out in the last
// PRESENCE_BROADCAST_MS; else at the end of that minute, from one alarm - unless one is already
// set. A burst of apps opening at once thus costs one message per socket a minute, not one each.
export function presenceBroadcast(
  now: number,
  lastSentAt: number | null,
  alarmAt: number | null
): { kind: 'now' } | { kind: 'alarm'; at: number } | { kind: 'wait' } {
  if (lastSentAt === null || now - lastSentAt >= PRESENCE_BROADCAST_MS) return { kind: 'now' };
  if (alarmAt !== null) return { kind: 'wait' };
  return { kind: 'alarm', at: lastSentAt + PRESENCE_BROADCAST_MS };
}
```

Inside the class:

```ts
  // Presence sockets: one per signed-in app in the foreground (GET /presence/ws, index.ts). The
  // Hibernation API keeps them open without billing this DO for the time; clients never send on
  // them, so a connection costs one request to open and nothing after.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/presence/ws') return new Response('Not found', { status: 404 });
    const token = url.searchParams.get('token');
    if (!token) return new Response('Missing token', { status: 401 });
    let user;
    try {
      user = await verifyToken(token, this.env);
    } catch {
      return new Response('Invalid token', { status: 401 });
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ playerId: user.sub });
    pair[1].send(onlineMessage(this.online()));
    await this.presenceChanged();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Only 1000 and 3000-4999 may be passed back to close() (see MatchDO.webSocketClose).
    if (code === 1000 || (code >= 3000 && code <= 4999)) ws.close(code, reason);
    else ws.close();
    await this.presenceChanged(ws);
  }

  // The online count changed: send it now, or leave it to the alarm (presenceBroadcast).
  private async presenceChanged(closing?: WebSocket): Promise<void> {
    const now = Date.now();
    const lastSentAt = (await this.ctx.storage.get<number>('presenceSentAt')) ?? null;
    const plan = presenceBroadcast(now, lastSentAt, await this.ctx.storage.getAlarm());
    if (plan.kind === 'now') await this.broadcastOnline(now, closing);
    else if (plan.kind === 'alarm') await this.ctx.storage.setAlarm(plan.at);
  }

  async alarm(): Promise<void> {
    await this.broadcastOnline(Date.now());
  }

  private async broadcastOnline(now: number, closing?: WebSocket): Promise<void> {
    await this.ctx.storage.put('presenceSentAt', now);
    const message = onlineMessage(this.online(closing));
    for (const ws of this.ctx.getWebSockets()) if (ws !== closing) ws.send(message);
  }

  // Distinct players with a presence socket open; two tabs or devices count once. A socket being
  // closed may still be listed while its close is handled, so it's left out by name.
  private online(closing?: WebSocket): number {
    const players = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing) continue;
      const attachment = ws.deserializeAttachment() as { playerId: string } | null;
      if (attachment) players.add(attachment.playerId);
    }
    return players.size;
  }
```

and at module scope:

```ts
function onlineMessage(online: number): string {
  return JSON.stringify({ type: 'online', online } satisfies PresenceMessage);
}
```

In `cloudflare/packages/api-types/src/index.ts` add:

```ts
// What the presence socket (GET /presence/ws) sends: how many players have the app open. On
// connect, then at most once a minute as people come and go.
export interface PresenceMessage {
  type: 'online';
  online: number;
}
```

`test/matchmakerPresence.test.ts` - copy the JWKS `beforeAll` (with `fetchMock`), `signToken`
and the `openSocket` helper from `test/matchDOSocket.test.ts` (key id
`'matchmaker-presence-test-key'`; point `openSocket` at a Matchmaker stub), then:

```ts
function firstMessage(ws: WebSocket): Promise<{ type: string; online: number }> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('message', (event) => resolve(JSON.parse((event as MessageEvent).data as string)), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

describe('Matchmaker presence sockets', () => {
  it('tells a new socket how many players are online, counting each player once', async () => {
    const stub = testEnv.MATCHMAKER.get(testEnv.MATCHMAKER.idFromName('presence-count'));
    const a = await openSocket(stub, `/presence/ws?token=${await signToken({ sub: 'a' })}`);
    const a2 = await openSocket(stub, `/presence/ws?token=${await signToken({ sub: 'a' })}`);
    const bToken = await signToken({ sub: 'b' });
    const res = await stub.fetch(`https://matchmaker/presence/ws?token=${bToken}`, { headers: { Upgrade: 'websocket' } });
    const b = res.webSocket!;
    const first = firstMessage(b);
    b.accept();

    expect(await first).toEqual({ type: 'online', online: 2 });
    for (const ws of [a.ws, a2.ws, b]) ws?.close();
  });

  it('refuses a socket without a valid token', async () => {
    const stub = testEnv.MATCHMAKER.get(testEnv.MATCHMAKER.idFromName('presence-auth'));
    const { status } = await openSocket(stub, '/presence/ws?token=nope');
    expect(status).toBe(401);
  });
});
```

(The listener is attached before `accept()` so the on-connect message can't be missed; drain and
close every socket before asserting where the copied helper's comment says to.)

- [ ] **Step 5: Run tests**

Run: `npm test -w @fortytwo/worker && npm run typecheck -w @fortytwo/worker`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cloudflare/apps/worker
git commit -m "feat(worker): Matchmaker durable object seats Live and Daily players"
```

---

### Task 7: Routes - matchmaking, resume, Active turn status

**Files:**
- Create: `cloudflare/apps/worker/src/routes/matchmaking.ts`
- Create: `cloudflare/apps/worker/src/lobbyTurns.ts`
- Create: `cloudflare/apps/worker/test/lobbyTurns.test.ts`
- Create: `cloudflare/apps/worker/test/routes.matchmaking.test.ts`
- Modify: `cloudflare/apps/worker/src/routes/matches.ts` (GET `/`, PATCH `/:id/players`)
- Modify: `cloudflare/apps/worker/src/requestBody.ts` (`mode`, `autopilot`)
- Modify: `cloudflare/apps/worker/src/index.ts` (mount route)

**Interfaces:**
- Consumes: `Matchmaker.play` (Task 6), `MatchDO.resume`, `MatchDO.getTurn` (Task 5), `TurnSummary` (Task 3)
- Produces:
  - `POST /api/matchmaking { mode: 'live' | 'daily' }` -> 200 match view (404 for live when bots are off)
  - `GET /presence/ws?token=` -> forwarded to the Matchmaker's socket upgrade (outside `/api`, like `/matches/:id/ws`)
  - `PATCH /api/matches/:id/players { autopilot: false }` -> 200 match view
  - `GET /api/matches?filter=Active` rows carry `turn: TurnSummary | null`
  - `withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null>`; `TURN_LOOKUP_MS = 500`

- [ ] **Step 1: Write the failing tests**

`test/lobbyTurns.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { withTimeout } from '../src/lobbyTurns';

describe('withTimeout', () => {
  it('passes a prompt answer through', async () => {
    expect(await withTimeout(Promise.resolve(7), 50)).toBe(7);
  });

  it('gives null for an answer that comes too late', async () => {
    const late = new Promise<number>((resolve) => setTimeout(() => resolve(7), 200));
    expect(await withTimeout(late, 10)).toBeNull();
  });

  it('gives null for a failure', async () => {
    expect(await withTimeout(Promise.reject(new Error('down')), 50)).toBeNull();
  });
});
```

`test/routes.matchmaking.test.ts` - copy the JWKS `beforeAll`, `signToken`, `api` helper and the
D1-wiping `beforeEach` from the top of `routes.matches.test.ts` verbatim (change `KEY_ID` to
`'routes-matchmaking-test-key'`), plus its `apiWithBots` helper from the "bots" describe block,
then:

```ts
describe('POST /api/matchmaking', () => {
  it('seats two Daily players at one table and lists it in Active as filling', async () => {
    const [a, b] = await Promise.all(['mm-a', 'mm-b'].map(signToken));
    const first = (await (await api('/api/matchmaking', a, { method: 'POST', body: JSON.stringify({ mode: 'daily' }) })).json()) as { id: string };
    const second = (await (await api('/api/matchmaking', b, { method: 'POST', body: JSON.stringify({ mode: 'daily' }) })).json()) as { id: string; players: unknown[] };

    expect(second.id).toBe(first.id);
    expect(second.players).toHaveLength(2);
    const listed = (await (await api('/api/matches?filter=Active', a)).json()) as { matches: { id: string; mode: string; turn: unknown }[] };
    expect(listed.matches).toEqual([expect.objectContaining({ id: first.id, mode: 'daily', turn: null })]);
  });

  it('refuses Live while bots are switched off', async () => {
    const res = await api('/api/matchmaking', await signToken('mm-c'), { method: 'POST', body: JSON.stringify({ mode: 'live' }) });
    expect(res.status).toBe(404);
  });

  it('starts a Live search when bots are on, kept out of Active until it is dealt', async () => {
    const token = await signToken('mm-d');
    const res = await apiWithBots('/api/matchmaking', token, { method: 'POST', body: JSON.stringify({ mode: 'live' }) });
    expect(res.status).toBe(200);
    const listed = (await (await api('/api/matches?filter=Active', token)).json()) as { matches: unknown[] };
    expect(listed.matches).toEqual([]);
  });

  it('rejects an unknown mode', async () => {
    const res = await api('/api/matchmaking', await signToken('mm-e'), { method: 'POST', body: JSON.stringify({ mode: 'blitz' }) });
    expect(res.status).toBe(400);
  });
});

describe('GET /presence/ws', () => {
  it('wants a WebSocket upgrade', async () => {
    const res = await SELF.fetch('https://example.com/presence/ws');
    expect(res.status).toBe(426);
    await res.text();
  });
});

describe('Active turn status', () => {
  it("says it's your turn on a dealt match", async () => {
    const tokens = await Promise.all(['t1', 't2', 't3', 't4'].map(signToken));
    const created = (await (await api('/api/matches', tokens[0], { method: 'POST' })).json()) as { id: string };
    for (const [token, position] of [[tokens[1], 1], [tokens[2], 2], [tokens[3], 3]] as const) {
      await (await api(`/api/matches/${created.id}/players`, token, { method: 'POST', body: JSON.stringify({ position }) })).arrayBuffer();
    }
    const match = (await (await api(`/api/matches/${created.id}`, tokens[0])).json()) as { currentGame: { currentPlayerId: string } };
    const turnToken = tokens[['t1', 't2', 't3', 't4'].indexOf(match.currentGame.currentPlayerId)];

    const listed = (await (await api('/api/matches?filter=Active', turnToken)).json()) as { matches: { turn: { kind: string; yours: boolean } }[] };

    expect(listed.matches[0].turn).toMatchObject({ kind: 'turn', yours: true });
  });
});

describe('PATCH /api/matches/:id/players { autopilot: false }', () => {
  it("refuses someone who isn't at the table", async () => {
    const owner = await signToken('ap-1');
    const created = (await (await api('/api/matches', owner, { method: 'POST' })).json()) as { id: string };
    const res = await api(`/api/matches/${created.id}/players`, await signToken('ap-2'), { method: 'PATCH', body: JSON.stringify({ autopilot: false }) });
    expect(res.status).toBe(400);
  });

  it('answers a seated player with the match', async () => {
    const owner = await signToken('ap-3');
    const created = (await (await api('/api/matches', owner, { method: 'POST' })).json()) as { id: string };
    const res = await api(`/api/matches/${created.id}/players`, owner, { method: 'PATCH', body: JSON.stringify({ autopilot: false }) });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @fortytwo/worker -- lobbyTurns routes.matchmaking`
Expected: FAIL - missing modules / 404 on `/api/matchmaking`.

- [ ] **Step 3: Body fields** (`requestBody.ts`)

```ts
// Which matchmaking queue: Live or Daily. (Custom tables come from POST /api/matches.)
export function mode(body: Body): 'live' | 'daily' {
  if (body.mode !== 'live' && body.mode !== 'daily') throw new BadRequestError('`mode` must be "live" or "daily".');
  return body.mode;
}

// Only ever false: a player takes their seat back from the bot. A bot takes it over on its own,
// when a Live turn runs out.
export function autopilotOff(body: Body): false {
  if (body.autopilot !== false) throw new BadRequestError('`autopilot` can only be set to false.');
  return false;
}
```

- [ ] **Step 4: `lobbyTurns.ts`**

```ts
// "Whose turn is it?" for the lobby's Active list, asked of each match's MatchDO as the page
// loads rather than kept in D1, which would cost a write on every turn. Each answer gets
// TURN_LOOKUP_MS; a match that doesn't answer in time, or fails, shows without a turn - the list
// itself never waits longer or fails for it.
import type { TurnSummary } from '@fortytwo/api-types';
import type { Env } from './index';
import type { MatchIndexRow } from './lobby';

export const TURN_LOOKUP_MS = 500;

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Each row's turn, by match id. Only a dealt match (four seated) has one worth asking for.
export async function turnsFor(
  env: Env,
  rows: MatchIndexRow[],
  viewerId: string,
  nameOf: (playerId: string) => string
): Promise<Map<string, TurnSummary | null>> {
  const entries = await Promise.all(
    rows.map(async (row): Promise<[string, TurnSummary | null]> => {
      if (row.status !== 'active' || row.playerCount < 4) return [row.id, null];
      const stub = env.MATCH_DO.get(env.MATCH_DO.idFromName(row.id));
      const result = await withTimeout(stub.getTurn(), TURN_LOOKUP_MS);
      if (result === null || !result.ok || result.value === null) return [row.id, null];
      const { kind, playerIds } = result.value;
      return [row.id, { kind, yours: playerIds.includes(viewerId), waitingOn: playerIds.map(nameOf) }];
    })
  );
  return new Map(entries);
}
```

- [ ] **Step 5: GET `/api/matches` and PATCH `/:id/players`** (`routes/matches.ts`)

In `matches.get('/')`, after `names` is computed, hoist `nameOf` out of the row mapper and look
turns up for Active only:

```ts
  const nameOf = (playerId: string) => names.get(playerId) ?? playerId;
  const turns = filter === 'Active' ? await turnsFor(c.env, rows, userId, nameOf) : null;
  const summaries = rows.map((row): MatchSummary => {
    const seated = playersByMatch.get(row.id) ?? [];
    const namesOn = (team: Teams) => seated.filter((p) => p.team === team).map((p) => nameOf(p.playerId));
    const seats = [0, 1, 2, 3].map((position) => {
      const player = seated.find((p) => p.position === position);
      return player ? nameOf(player.playerId) : null;
    });
    return {
      ...row,
      mode: row.mode ?? 'custom',
      teams: [namesOn(Teams.TeamA), namesOn(Teams.TeamB)],
      seats,
      ...(turns ? { turn: turns.get(row.id) ?? null } : {}),
    };
  });
```

(import `turnsFor` from `../lobbyTurns`.)

Replace `matches.patch('/:id/players', ...)`:

```ts
// Readying up can finish a hand's wait and deal the next one, so it always carries a deck.
// `{ autopilot: false }` instead takes the caller's seat back from the bot (a Live turn ran out).
matches.patch('/:id/players', async (c) => {
  const body = await readBody(c);
  const match = matchStub(c.env, c.req.param('id'));
  if (body.autopilot !== undefined) {
    field.autopilotOff(body);
    return replyWithMatch(c, await match.resume(c.get('user').sub));
  }
  const result = await match.readyUp(c.get('user').sub, field.ready(body), shuffledDominoOrder());
  return replyWithMatch(c, result, { lobbySync: 'summary' });
});
```

- [ ] **Step 6: `routes/matchmaking.ts` and mount**

```ts
// POST /api/matchmaking { mode }: Live or Daily play. The Matchmaker (matchmaker.ts) seats the
// caller at an open table of that mode or starts one; the reply is that match, as the caller may
// see it, and the client opens it. Live needs bots to fill its seats, so it's off with them
// (BOTS_ENABLED 'false'), as adding bots is.
import { Hono } from 'hono';
import type { AppEnv } from '../index';
import { botsEnabled } from '../bots';
import { bestEffort, syncLobbyIndex } from '../lobby';
import * as field from '../requestBody';
import { readBody } from '../requestBody';
import { matchViewFor } from '@fortytwo/rules';

const matchmaking = new Hono<AppEnv>();

matchmaking.post('/', async (c) => {
  const mode = field.mode(await readBody(c));
  if (mode === 'live' && !botsEnabled(c.env)) return c.json({ title: 'Not found' }, 404);
  const userId = c.get('user').sub;
  const match = await c.env.MATCHMAKER.get(c.env.MATCHMAKER.idFromName('global')).play(userId, mode);
  await bestEffort(match.id, () => syncLobbyIndex(c.env.DB, match));
  return c.json(matchViewFor(match, userId));
});

export default matchmaking;
```

In `index.ts`: `import matchmakingRoutes from './routes/matchmaking';` and, next to the matches
route, `app.route('/api/matchmaking', matchmakingRoutes);`. Then, beside the `/matches/:id/ws`
route (outside `/api/*`'s `requireAuth`, for the same reason - an upgrade can't carry an
Authorization header, so the Matchmaker checks `?token=` itself):

```ts
// The presence socket (matchmaker.ts): the online count. The Matchmaker is addressed by the one
// name, and its fetch() expects this same path, so the request goes through unchanged.
app.get('/presence/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }
  return c.env.MATCHMAKER.get(c.env.MATCHMAKER.idFromName('global')).fetch(c.req.raw);
});
```

and in `wrangler.toml` add `"/presence/*"` to `[assets] run_worker_first`.

- [ ] **Step 7: Run tests and typecheck**

Run: `npm test -w @fortytwo/worker && npm run typecheck -w @fortytwo/worker`
Expected: PASS. Existing route tests that assert the exact shape of Active rows may now need
`mode: 'custom'` and `turn: null` added to their expected objects - update those expectations
(they describe the new response), don't loosen them to `objectContaining` unless they already were.

- [ ] **Step 8: Commit**

```bash
git add cloudflare/apps/worker
git commit -m "feat(worker): matchmaking route, resume, and turn status in Active"
```

---

### Task 8: Client package - API calls and lobby/live helpers

**Files:**
- Modify: `cloudflare/packages/client/src/api.ts`
- Modify: `cloudflare/packages/client/src/lobby.ts`, `lobby.test.ts`
- Create: `cloudflare/packages/client/src/live.ts`, `live.test.ts`
- Create: `cloudflare/packages/client/src/socket.ts`, `presenceSocket.ts`, `presenceSocket.test.ts`
- Modify: `cloudflare/packages/client/src/matchSocket.ts`
- Modify: `cloudflare/packages/client/src/index.ts`

**Interfaces:**
- Consumes: `MatchSummary`, `TurnSummary` (Task 3); `PresenceMessage` (Task 6); `liveDeadline`, `matchMode`, `hasBeenDealt`, `isOnAutopilot` (Task 1)
- Produces:
  - api: `play(mode: 'live' | 'daily'): Promise<MatchState>`, `resume(id: string): Promise<MatchState>`
  - socket: `connectSocket(options: SocketOptions): () => void` - the reconnect loop `connectMatchSocket` had, now shared
  - presence: `connectPresenceSocket({ origin, getToken, onOnline, subscribeWake }): () => void`
  - lobby: `rowStatus(match: MatchSummary): { text: string; yours: boolean }`, `yourTurnFirst(rows: MatchSummary[]): MatchSummary[]`, `MODE_LABELS: Record<MatchMode, string>`
  - live: `searchState(match: MatchState, now: number): { mode: 'live'; elapsedMs: number } | { mode: 'daily' } | null`, `turnClock(match: MatchState, now: number): { playerIds: string[]; remainingMs: number } | null`, `formatClock(ms: number): string`

- [ ] **Step 1: Write the failing tests**

Append to `lobby.test.ts`:

```ts
import { rowStatus, yourTurnFirst } from './lobby';

const summary = (overrides: Partial<MatchSummary>): MatchSummary => ({
  id: 'm',
  status: 'active',
  playerCount: 4,
  updatedOn: '2026-01-01T00:00:00Z',
  teams: [[], []],
  seats: [null, null, null, null],
  mode: 'daily',
  ...overrides,
});

describe('rowStatus', () => {
  it('reads each state the way the lobby shows it', () => {
    expect(rowStatus(summary({ status: 'completed' }))).toEqual({ text: 'Finished', yours: false });
    expect(rowStatus(summary({ playerCount: 2 }))).toEqual({ text: 'Looking for players · 2 of 4', yours: false });
    expect(rowStatus(summary({ turn: { kind: 'turn', yours: true, waitingOn: ['Me'] } }))).toEqual({ text: 'Your turn', yours: true });
    expect(rowStatus(summary({ turn: { kind: 'ready', yours: true, waitingOn: ['Me', 'Eli'] } }))).toEqual({ text: 'Ready up', yours: true });
    expect(rowStatus(summary({ turn: { kind: 'turn', yours: false, waitingOn: ['Eli'] } }))).toEqual({ text: "Eli's turn", yours: false });
    expect(rowStatus(summary({ turn: { kind: 'ready', yours: false, waitingOn: ['Eli'] } }))).toEqual({ text: 'Waiting for others to ready up', yours: false });
    expect(rowStatus(summary({ turn: null }))).toEqual({ text: 'In play', yours: false });
  });
});

describe('yourTurnFirst', () => {
  it('moves your-turn rows to the top and keeps the rest in order', () => {
    const rows = [
      summary({ id: 'a' }),
      summary({ id: 'b', turn: { kind: 'turn', yours: true, waitingOn: ['Me'] } }),
      summary({ id: 'c' }),
    ];
    expect(yourTurnFirst(rows).map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });
});
```

`live.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LIVE_FILL_MS, LIVE_TURN_MS, createDomino, createMatch, takeSeat, type Domino, type MatchState } from '@fortytwo/rules';
import { formatClock, searchState, turnClock } from './live';

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}
function dealt(mode: 'live' | 'daily'): MatchState {
  let match = createMatch('p1', mode);
  match = takeSeat(match, 'p2', 1);
  match = takeSeat(match, 'p3', 2);
  return takeSeat(match, 'p4', 3, deck());
}

describe('searchState', () => {
  it('counts a Live search up from when it began', () => {
    const match = createMatch('p1', 'live');
    const now = Date.parse(match.searchStartedOn!) + 23_000;
    expect(searchState(match, now)).toEqual({ mode: 'live', elapsedMs: 23_000 });
  });

  it('says a Daily table is still looking, and nothing for a custom one or a dealt one', () => {
    expect(searchState(createMatch('p1', 'daily'), Date.now())).toEqual({ mode: 'daily' });
    expect(searchState(createMatch('p1'), Date.now())).toBeNull();
    expect(searchState(dealt('live'), Date.now())).toBeNull();
  });
});

describe('turnClock', () => {
  it('counts the Live turn down, never below zero', () => {
    const match = dealt('live');
    const start = Date.parse(match.updatedOn);
    expect(turnClock(match, start + 10_000)).toEqual({ playerIds: ['p1'], remainingMs: LIVE_TURN_MS - 10_000 });
    expect(turnClock(match, start + LIVE_TURN_MS * 2)!.remainingMs).toBe(0);
  });

  it('has no clock outside Live, or while filling', () => {
    expect(turnClock(dealt('daily'), Date.now())).toBeNull();
    expect(turnClock(createMatch('p1', 'live'), Date.now() + LIVE_FILL_MS)).toBeNull();
  });
});

describe('formatClock', () => {
  it('reads as m:ss, rounding seconds up so a countdown never shows 0:00 early', () => {
    expect(formatClock(23_000)).toBe('0:23');
    expect(formatClock(59_100)).toBe('1:00');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(125_000)).toBe('2:05');
  });
});
```

Note the `formatClock` rounding: a count-up (search elapsed) uses the same function; rounding
up there is acceptable (shows 0:01 a beat early).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @fortytwo/client`
Expected: FAIL - missing exports.

- [ ] **Step 3: Implement**

`lobby.ts` additions:

```ts
import type { MatchMode, MatchPage, MatchSummary } from '@fortytwo/api-types';

export const MODE_LABELS: Record<MatchMode, string> = { live: 'Live', daily: 'Daily', custom: 'Custom' };

// What a lobby row says the match is waiting on, and whether that's the viewer.
export function rowStatus(match: MatchSummary): { text: string; yours: boolean } {
  if (match.status === 'completed') return { text: 'Finished', yours: false };
  if (match.playerCount < 4) return { text: `Looking for players · ${match.playerCount} of 4`, yours: false };
  const turn = match.turn;
  if (turn == null) return { text: 'In play', yours: false };
  if (turn.yours) return { text: turn.kind === 'ready' ? 'Ready up' : 'Your turn', yours: true };
  if (turn.kind === 'ready') return { text: 'Waiting for others to ready up', yours: false };
  return { text: `${turn.waitingOn[0] ?? 'Someone'}'s turn`, yours: false };
}

// Games waiting on the viewer first, the rest in the order they came. Only sorts rows already
// loaded: pages still arrive newest first.
export function yourTurnFirst(rows: MatchSummary[]): MatchSummary[] {
  return [...rows.filter((m) => m.turn?.yours), ...rows.filter((m) => !m.turn?.yours)];
}
```

`live.ts`:

```ts
// What the match page shows of Live and Daily play: how long a search has run, and the clock on
// a Live turn - from the same deadlines the Worker acts on (@fortytwo/rules' live.ts).
import { hasBeenDealt, liveDeadline, matchMode, type MatchState } from '@fortytwo/rules';

// A table still looking for players: a Live search counting up, or a Daily table waiting.
export function searchState(match: MatchState, now: number): { mode: 'live'; elapsedMs: number } | { mode: 'daily' } | null {
  if (match.players.length >= 4 || hasBeenDealt(match)) return null;
  const mode = matchMode(match);
  if (mode === 'daily') return { mode: 'daily' };
  if (mode === 'live' && match.searchStartedOn !== undefined) {
    return { mode: 'live', elapsedMs: Math.max(0, now - Date.parse(match.searchStartedOn)) };
  }
  return null;
}

// Time left on a Live turn before a bot plays it, and whose it is.
export function turnClock(match: MatchState, now: number): { playerIds: string[]; remainingMs: number } | null {
  const deadline = liveDeadline(match);
  if (deadline === null || deadline.kind !== 'turn') return null;
  return { playerIds: deadline.playerIds, remainingMs: Math.max(0, deadline.at - now) };
}

export function formatClock(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
```

`api.ts`, after `createMatch`:

```ts
    // Live or Daily play: seats the caller at an open table of that mode, or starts one.
    play: (mode: 'live' | 'daily'): Promise<MatchState> =>
      request<MatchState>('/api/matchmaking', { method: 'POST', body: JSON.stringify({ mode }) }),
```

and after `readyUp`:

```ts
    // Takes the caller's seat back from the bot after a Live turn ran out.
    resume: (id: string): Promise<MatchState> =>
      request<MatchState>(`/api/matches/${id}/players`, { method: 'PATCH', body: JSON.stringify({ autopilot: false }) }),
```

**The shared socket loop.** Move the body of `connectMatchSocket` (token fetch, connect,
backoff from 1 s doubling to 30 s, wake-ups, dispose) into `socket.ts` unchanged except that
what's match-specific becomes options:

```ts
// One server socket kept open: a fresh token on every connect, exponential backoff (1 s doubling to
// 30 s) after a drop, and an immediate retry on a wake-up. Shared by the match socket
// (matchSocket.ts) and the presence socket (presenceSocket.ts), which add their own messages.
export interface SocketOptions {
  // The full URL to open, given a fresh token.
  url: (token: string) => string;
  getToken: () => Promise<string>;
  onOpen?: () => void;
  // Each parsed JSON frame; malformed ones are dropped before this.
  onMessage: (data: unknown) => void;
  // A socket closed on us. A retry follows unless the close code is in `finalCodes`.
  onDrop?: (code: number) => void;
  // Close codes meaning "don't come back".
  finalCodes?: ReadonlySet<number>;
  subscribeWake?: (wake: () => void) => () => void;
}

export function connectSocket(options: SocketOptions): () => void {
  // ...the loop from connectMatchSocket, with
  //   new WebSocket(options.url(token))
  //   onMessage(JSON.parse(...)) for each well-formed frame
  //   onDrop?.(event.code), then `if (finalCodes?.has(event.code)) return;` before scheduling
}
```

Copy the loop's code and comments over verbatim - it's the same logic, with those three lines
changed. Then `connectMatchSocket` becomes a wrapper with the same signature as today:

```ts
export function connectMatchSocket({ matchId, origin, getToken, onOpen, onMatch, onPoke, onDrop, onDeleted, subscribeWake }: MatchSocketOptions): () => void {
  return connectSocket({
    url: (token) => `${origin}/matches/${matchId}/ws?token=${token}`,
    getToken,
    onOpen,
    onMessage: (data) => {
      if (isMatchSocketMessage(data)) onMatch(data.match);
      else if (isPokeSocketMessage(data)) onPoke?.(data.from);
    },
    onDrop: (code) => {
      onDrop();
      if (code === MATCH_DELETED_CLOSE_CODE) onDeleted?.();
    },
    finalCodes: NO_RECONNECT_CODES,
    subscribeWake,
  });
}
```

`matchSocket.test.ts` must pass unchanged - it's the check that nothing moved but the code.

`presenceSocket.ts`:

```ts
// The presence socket (the Worker's matchmaker.ts): how many players have the app open. One per
// signed-in app while it's in front; the server sends the count on connect and then at most once
// a minute, and the client sends nothing.
import type { PresenceMessage } from '@fortytwo/api-types';
import { connectSocket } from './socket';

function isPresenceMessage(value: unknown): value is PresenceMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'online' &&
    typeof (value as { online?: unknown }).online === 'number'
  );
}

export function connectPresenceSocket({
  origin,
  getToken,
  onOnline,
  subscribeWake,
}: {
  origin: string;
  getToken: () => Promise<string>;
  onOnline: (online: number) => void;
  subscribeWake?: (wake: () => void) => () => void;
}): () => void {
  return connectSocket({
    url: (token) => `${origin}/presence/ws?token=${token}`,
    getToken,
    onMessage: (data) => {
      if (isPresenceMessage(data)) onOnline(data.online);
    },
    subscribeWake,
  });
}
```

`presenceSocket.test.ts` - using the same fake `WebSocket` that `matchSocket.test.ts` installs
(copy its setup):

```ts
describe('connectPresenceSocket', () => {
  it('opens the presence path with a token and reports each count', async () => {
    const onOnline = vi.fn();
    const dispose = connectPresenceSocket({ origin: 'wss://x', getToken: async () => 't', onOnline });
    const socket = await lastSocket();
    expect(socket.url).toBe('wss://x/presence/ws?token=t');
    socket.receive({ type: 'online', online: 3 });
    socket.receive({ type: 'match', match: {} });
    expect(onOnline.mock.calls).toEqual([[3]]);
    dispose();
  });
});
```

(`lastSocket`/`receive` stand for whatever the copied fake provides to get the opened socket and
deliver a frame.)

`index.ts`: add `export * from './live';`, `export * from './socket';` and
`export * from './presenceSocket';`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -w @fortytwo/client && npm run typecheck -w @fortytwo/client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare/packages/client
git commit -m "feat(client): matchmaking calls and lobby/live helpers"
```

---

### Task 9: Web lobby - Active/History and the New match chooser

**Files:**
- Create: `cloudflare/apps/web/src/components/NewMatchDialog.tsx`, `NewMatchDialog.css`, `NewMatchDialog.test.tsx`
- Create: `cloudflare/apps/web/src/api/presence.tsx`
- Modify: `cloudflare/apps/web/src/main.tsx`
- Modify: `cloudflare/apps/web/src/pages/Lobby.tsx`, `Lobby.css`, `Lobby.test.tsx`

**Interfaces:**
- Consumes: `play`, `createMatch`, `listMatches`, `getConfig` (client); `rowStatus`, `yourTurnFirst`, `MODE_LABELS`, `connectPresenceSocket` (Task 8)
- Produces: `PresenceProvider` and `useOnline(): number | null` in `apps/web/src/api/presence.tsx`
- Produces: `NewMatchDialog({ open, liveEnabled, online, pending, onChoose, onClose })` (`online: number | null`) where `onChoose: (choice: 'live' | 'daily' | 'challenge') => void`

- [ ] **Step 1: Write the failing tests**

`NewMatchDialog.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewMatchDialog } from './NewMatchDialog';

afterEach(cleanup);

describe('NewMatchDialog', () => {
  it('offers Live, Daily and Challenge friends, and reports the choice', () => {
    const onChoose = vi.fn();
    render(<NewMatchDialog open liveEnabled online={null} pending={false} onChoose={onChoose} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /live/i }));
    fireEvent.click(screen.getByRole('button', { name: /daily/i }));
    fireEvent.click(screen.getByRole('button', { name: /challenge friends/i }));
    expect(onChoose.mock.calls).toEqual([['live'], ['daily'], ['challenge']]);
  });

  it('leaves Live out when bots are off', () => {
    render(<NewMatchDialog open liveEnabled={false} online={null} pending={false} onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /live/i })).toBeNull();
  });

  it('renders nothing while closed', () => {
    render(<NewMatchDialog open={false} liveEnabled online={null} pending={false} onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says how many players are online', () => {
    render(<NewMatchDialog open liveEnabled online={5} pending={false} onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('5 online')).toBeTruthy();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<NewMatchDialog open liveEnabled online={null} pending={false} onChoose={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
```

In `Lobby.test.tsx`:
- Add `playMock` and `getConfigMock` to the `vi.hoisted` block and the mocked `apiClient`
  (`play: playMock, getConfig: getConfigMock`); in a `beforeEach`,
  `getConfigMock.mockResolvedValue({ bots: true })`. Mock the presence hook:
  `vi.mock('../api/presence', () => ({ useOnline: () => 3 }));`
- Add `mode: 'custom'` to every fixture `MatchSummary` (and `mode: 'daily'` where it reads better).
- Delete the tests about the Find a Game tab and seat picker/join.
- Add:

```tsx
  it('shows only the Active and History tabs', async () => {
    renderLobby();
    expect(await screen.findByRole('tab', { name: /active/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /history/i })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /find a game/i })).toBeNull();
  });

  it('puts your-turn games first, with a badge', async () => {
    listMatchesMock.mockResolvedValue({
      matches: [
        { ...ACTIVE_FIXTURE[0], id: 'theirs', turn: { kind: 'turn', yours: false, waitingOn: ['Eli'] } },
        { ...ACTIVE_FIXTURE[0], id: 'mine', turn: { kind: 'turn', yours: true, waitingOn: ['Alice'] } },
      ],
      nextCursor: null,
    });
    renderLobby();
    const rows = await screen.findAllByRole('listitem');
    expect(within(rows[0]).getByText('Your turn')).toBeTruthy();
    expect(within(rows[1]).getByText("Eli's turn")).toBeTruthy();
  });

  it('starts Daily matchmaking from the chooser and opens the match', async () => {
    playMock.mockResolvedValue({ id: 'daily-1' } as MatchState);
    renderLobby();
    fireEvent.click(await screen.findByRole('button', { name: /new match/i }));
    fireEvent.click(screen.getByRole('button', { name: /daily/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/match/daily-1'));
    expect(playMock).toHaveBeenCalledWith('daily');
  });

  it('shows how many players are online in the chooser', async () => {
    renderLobby();
    fireEvent.click(await screen.findByRole('button', { name: /new match/i }));
    expect(await screen.findByText('3 online')).toBeTruthy();
  });

  it('creates a custom table for Challenge friends', async () => {
    createMatchMock.mockResolvedValue({ id: 'custom-1' } as MatchState);
    renderLobby();
    fireEvent.click(await screen.findByRole('button', { name: /new match/i }));
    fireEvent.click(screen.getByRole('button', { name: /challenge friends/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/match/custom-1'));
  });
```

(Use the file's existing render helper - if it's named differently from `renderLobby`, use that
name. If the existing "Create match" test clicks a button named "Create match", replace it with
the Challenge test above.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @fortytwo/web -- Lobby NewMatchDialog`
Expected: FAIL.

- [ ] **Step 3: `NewMatchDialog.tsx`**

```tsx
// The New match chooser: Live and Daily go to matchmaking, Challenge friends sets up a table to
// share (a custom match). Live is left out while bots are off, since it relies on them to fill
// its seats.
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import './NewMatchDialog.css';

export type NewMatchChoice = 'live' | 'daily' | 'challenge';

const OPTIONS: { choice: NewMatchChoice; title: string; detail: string; icon: string }[] = [
  { choice: 'live', title: 'Live', detail: "Play now with whoever's around. Start with bots whenever you like.", icon: '⚡' },
  { choice: 'daily', title: 'Daily', detail: "Take your turns whenever. We'll notify you.", icon: '☀' },
  { choice: 'challenge', title: 'Challenge friends', detail: 'Set up a table and share the invite link.', icon: '✉' },
];

export function NewMatchDialog({
  open,
  liveEnabled,
  online,
  pending,
  onChoose,
  onClose,
}: {
  open: boolean;
  liveEnabled: boolean;
  // Players online (the presence socket), or null until the first count arrives.
  online: number | null;
  pending: boolean;
  onChoose: (choice: NewMatchChoice) => void;
  onClose: () => void;
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);
  if (!open) return null;

  return (
    <div className="new-match-scrim" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-match-title"
        tabIndex={-1}
        className="new-match-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2 id="new-match-title" className="new-match-title">New match</h2>
        {online !== null && <p className="new-match-online">{online} online</p>}
        {OPTIONS.filter((o) => liveEnabled || o.choice !== 'live').map((o) => (
          <button
            key={o.choice}
            type="button"
            className="new-match-option"
            disabled={pending}
            onClick={() => onChoose(o.choice)}
          >
            <span className="new-match-icon" aria-hidden="true">{o.icon}</span>
            <span className="new-match-text">
              <span className="new-match-option-title">{o.title}</span>
              <span className="new-match-option-detail">{o.detail}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

`NewMatchDialog.css`:

```css
/* NewMatchDialog.tsx: the New match chooser, a small panel over a dimmed lobby. Options are
   name plates on the table's mat, like the lobby's rows. */
.new-match-scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(10, 6, 4, 0.6);
}

.new-match-dialog {
  width: min(22rem, 100%);
  padding: 1.25rem;
  border-radius: 1rem;
  background: var(--walnut-deep);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6);
  outline: none;
}

.new-match-title {
  margin: 0 0 0.75rem;
  font: 1.35rem var(--font-display);
  color: var(--bone);
}

.new-match-online {
  margin: -0.5rem 0 0.75rem;
  font: 0.85rem var(--font-ui);
  color: var(--brass);
}

.new-match-option {
  appearance: none;
  display: flex;
  gap: 0.75rem;
  align-items: center;
  width: 100%;
  margin-bottom: 0.5rem;
  padding: 0.75rem;
  border: none;
  border-radius: 0.75rem;
  background: radial-gradient(ellipse at 50% 30%, #5a4130, var(--mat) 75%);
  color: var(--bone);
  text-align: left;
  cursor: pointer;
}

.new-match-option:hover:not(:disabled) {
  box-shadow: inset 0 0 0 1px var(--brass);
}

.new-match-option:disabled {
  opacity: 0.6;
  cursor: default;
}

.new-match-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  border-radius: 0.5rem;
  background: var(--brass);
  color: var(--walnut-deep);
}

.new-match-text {
  display: flex;
  flex-direction: column;
}

.new-match-option-title {
  font: 600 1rem var(--font-ui);
}

.new-match-option-detail {
  font: 0.8rem var(--font-ui);
  color: var(--ink-muted);
}
```

- [ ] **Step 4: `api/presence.tsx`** - one presence socket for the signed-in app

```tsx
// The online count, from one presence socket (@fortytwo/client's connectPresenceSocket) held
// while the app is signed in. A context, so the lobby and the match page share the one socket
// rather than each opening their own as the player moves between them.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { connectPresenceSocket } from '@fortytwo/client';
import { useGetToken } from '../auth/useGetToken';

const OnlineContext = createContext<number | null>(null);

// The same wake-ups useMatchSocket uses: the tab coming back, or the network returning.
function subscribeBrowserWake(wake: () => void): () => void {
  function onVisibilityChange() {
    if (document.visibilityState === 'visible') wake();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', wake);
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('online', wake);
  };
}

export function PresenceProvider({ children }: { children: ReactNode }): JSX.Element {
  const [online, setOnline] = useState<number | null>(null);
  const getToken = useGetToken();
  // Kept in a ref so a new getToken closure doesn't reopen the socket (as in useMatchSocket).
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  useEffect(
    () =>
      connectPresenceSocket({
        origin:
          import.meta.env.VITE_WS_ORIGIN ||
          `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`,
        getToken: () => getTokenRef.current(),
        onOnline: setOnline,
        subscribeWake: subscribeBrowserWake,
      }),
    []
  );

  return <OnlineContext.Provider value={online}>{children}</OnlineContext.Provider>;
}

// Players with the app open, or null until the first count arrives.
export function useOnline(): number | null {
  return useContext(OnlineContext);
}
```

(If `useMatchSocket.ts` exports `subscribeBrowserWake`, import it instead of repeating it -
export it from there if it isn't.) In `main.tsx`, wrap `<NavBar />` and `<Routes>` inside
`<AuthGate>` with `<PresenceProvider>`, so it only connects once signed in.

- [ ] **Step 5: `Lobby.tsx`**

- Header comment: "The lobby: the player's matches (Active, the default, and Game History) plus
  the New match chooser - Live and Daily matchmaking, or a custom table to share..." Drop the
  Find a Game paragraph.
- `type MatchFilter = 'Active' | 'Completed';` and `TABS` without `Joinable`; drop its
  `EMPTY_LABELS` entry; Active's empty label: `"You're not in any games. Start a new match."`
- Remove `SeatPicker`/`SEAT_SIDES` imports except `SEAT_SIDES` (still used by `SeatGlyph`),
  `pickingSeatIn`, `joinMatch`, and the join button/picker in the row.
- Add config and chooser state:

```tsx
  const config = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig() });
  const online = useOnline();
  const [choosing, setChoosing] = useState(false);

  // Live and Daily seat the player through matchmaking; Challenge friends starts a custom table.
  const startMatch = useMutation({
    mutationFn: (choice: NewMatchChoice) => (choice === 'challenge' ? client.createMatch() : client.play(choice)),
    onSuccess: (match) => {
      setChoosing(false);
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      navigate(`/match/${match.id}`);
    },
  });
```

  (`useQuery` from `@tanstack/react-query`; if the Match page already caches config under a
  different key, reuse that key.) Replace `createMatch` usages with `startMatch`; the header
  button becomes `New match`, `onClick={() => setChoosing(true)}`; render
  `<NewMatchDialog open={choosing} liveEnabled={config.data?.bots ?? false} online={online} pending={startMatch.isPending} onChoose={(c) => startMatch.mutate(c)} onClose={() => setChoosing(false)} />`
  and show `startMatch.error` where `createMatch.error` was.
- Rows: `const matches = uniqueMatches(...)` then `const rows = matches && yourTurnFirst(matches);`
  and render from `rows`. In each row's meta replace the "N of 4 seated, updated ..." text with:

```tsx
                    <span className="lobby-match-meta">
                      {MODE_LABELS[match.mode]} · {status.text} · {formatUpdated(match.updatedOn)}
                    </span>
```

  with `const status = rowStatus(match);` at the top of the map callback, and after the text span:

```tsx
                  {status.yours && <span className="lobby-badge">{status.text}</span>}
```

  For the your-turn row the meta then repeats "Your turn"; use `status.yours ? MODE_LABELS[match.mode] : `${MODE_LABELS[match.mode]} · ${status.text}`` to avoid it.

`Lobby.css`: delete the Find-a-Game-only rules (seat picker in a row, join button) and add:

```css
/* A row waiting on the player: a brass tag, like the nav's current-page underline. */
.lobby-badge {
  flex: none;
  align-self: center;
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
  background: var(--brass);
  color: var(--walnut-deep);
  font: 700 0.75rem var(--font-ui);
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -w @fortytwo/web && npm run typecheck -w @fortytwo/web`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cloudflare/apps/web/src
git commit -m "feat(web): New match chooser, online count and your-turn lobby"
```

---

### Task 10: Web match page - searching, Live clock, away and Resume

**Files:**
- Create: `cloudflare/apps/web/src/match/useNow.ts`
- Modify: `cloudflare/apps/web/src/pages/Match.tsx`
- Modify: `cloudflare/apps/web/src/components/Seat.tsx`
- Modify: the stylesheet that holds `.table-waiting` / `.seat-plate` (find with `grep -rn "table-waiting" cloudflare/apps/web/src --include=*.css`)
- Test: `cloudflare/apps/web/src/pages/Match.test.tsx`

**Interfaces:**
- Consumes: `searchState`, `turnClock`, `formatClock` (Task 8); `isOnAutopilot`, `matchMode` (Task 1); `client.resume` (Task 8); `useOnline` (Task 9)
- Produces: `useNow(enabled: boolean, intervalMs?: number): number`; `SeatProps` gains `away: boolean`, `clock: string | null`

- [ ] **Step 1: Write the failing tests** (in `Match.test.tsx`; add `resumeMock` to the hoisted mocks and `resume: resumeMock` to the mocked client, and mock the presence hook: `vi.mock('../api/presence', () => ({ useOnline: () => 4 }));`)

```tsx
  describe('Live and Daily', () => {
    function searching(mode: 'live' | 'daily') {
      return baseMatch(
        { players: [PLAYERS[0]], mode, ...(mode === 'live' ? { searchStartedOn: new Date(Date.now() - 23_000).toISOString() } : {}) },
        { hands: [{ playerId: 'p1', team: Teams.TeamA, dominoes: [], bid: null }] }
      );
    }

    it('shows a Live search counting up, who is online, Start now with bots and Cancel search', async () => {
      useMatchSocketMock.mockReturnValue({ match: searching('live'), connected: true });
      getConfigMock.mockResolvedValue({ bots: true });
      renderMatch();
      expect(await screen.findByText(/finding players… 0:2[34]/i)).toBeTruthy();
      expect(await screen.findByText('4 online')).toBeTruthy();
      expect(screen.getByRole('button', { name: /cancel search/i })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /invite friends/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /fill with bots/i })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /start now with bots/i }));
      await waitFor(() => expect(addBotsMock).toHaveBeenCalledWith('match-1', undefined));
    });

    it('tells a Daily player they will hear when the table fills', async () => {
      useMatchSocketMock.mockReturnValue({ match: searching('daily'), connected: true });
      renderMatch();
      expect(await screen.findByText(/we'll notify you when the table fills/i)).toBeTruthy();
    });

    it('offers Resume to a player on autopilot', async () => {
      useMatchSocketMock.mockReturnValue({ match: baseMatch({ mode: 'live', autopilot: ['p1'] }), connected: true });
      resumeMock.mockResolvedValue(baseMatch({ mode: 'live' }));
      renderMatch();
      fireEvent.click(await screen.findByRole('button', { name: /resume/i }));
      await waitFor(() => expect(resumeMock).toHaveBeenCalledWith('match-1'));
    });

    it('marks another player on autopilot as away', async () => {
      useMatchSocketMock.mockReturnValue({ match: baseMatch({ mode: 'live', autopilot: ['p2'] }), connected: true });
      renderMatch();
      expect(await screen.findByText(/away/i)).toBeTruthy();
    });
  });
```

`baseMatch` in this file deals hands to all four, so the autopilot cases are mid-hand. If
`baseMatch`'s default `currentGame` leaves no dominoes in hand, pass hands from an existing dealt
fixture in this file.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @fortytwo/web -- Match.test`
Expected: FAIL.

- [ ] **Step 3: `useNow.ts`**

```ts
// The current time, ticking every `intervalMs` while `enabled` - for countdowns and count-ups.
// Stopped, it costs nothing, so pages only run it while a clock is on screen.
import { useEffect, useState } from 'react';

export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}
```

- [ ] **Step 4: `Seat.tsx`**

Add to `SeatProps`:

```ts
  // On autopilot: a bot is playing for them after a Live turn ran out.
  away: boolean;
  // Time left on their Live turn ("0:42"), or null.
  clock: string | null;
```

Destructure them in `Seat`, and inside `.seat-plate` after the name span render:

```tsx
        {away && <span className="seat-tag seat-away">Away</span>}
        {clock !== null && <span className="seat-tag seat-clock" aria-label={`${clock} left`}>{clock}</span>}
```

(If the plate already has a tag class for Dealer/Lead, reuse it in place of `seat-tag`.)

- [ ] **Step 5: `Match.tsx`**

Near the other derived state (after `match`/`view` are known):

```tsx
  const search = match ? searchState(match, Date.now()) : null;
  const clockRunning = match != null && (search?.mode === 'live' || turnClock(match, Date.now()) !== null);
  const now = useNow(clockRunning);
  const liveSearch = match ? searchState(match, now) : null;
  const clock = match ? turnClock(match, now) : null;
  const mode = match ? matchMode(match) : 'custom';
  const meOnAutopilot = match != null && myPlayerId != null && isOnAutopilot(match, myPlayerId);

  const resumeMutation = useMutation({
    mutationFn: () => client.resume(matchId!),
    onError: toastError,
  });
  const online = useOnline();
```

Hooks must run unconditionally, so place these above any early `return` in the component
(where the other `useMutation` calls are), guarding on `match` as shown.

`seatPropsFor` gains:

```tsx
      away: isOnAutopilot(match!, playerId),
      clock: clock?.playerIds.includes(playerId) ? formatClock(clock.remainingMs) : null,
```

In the `.table-waiting` block:
- Before the "N of 4 seated" paragraph, render the search line:

```tsx
                    {liveSearch?.mode === 'live' && (
                      <>
                        <p className="table-search" role="status">Finding players… {formatClock(liveSearch.elapsedMs)}</p>
                        {online !== null && <p className="table-presence">{online} online</p>}
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-secondary"
                          disabled={!connected || addBotsMutation.isPending}
                          onClick={() => addBotsMutation.mutate(undefined)}
                        >
                          Start now with bots
                        </button>
                      </>
                    )}
                    {liveSearch?.mode === 'daily' && (
                      <p className="table-search" role="status">Looking for players - we'll notify you when the table fills.</p>
                    )}
```

- Wrap "Invite friends" and "Fill with bots" in `mode === 'custom' && (...)`.
- The leave button's label: `mode === 'live' ? 'Cancel search' : onlyHumanSeated ? 'Cancel match' : 'Leave table'`,
  and for Live skip the `window.confirm` (cancelling a search is cheap and expected).

Above the table (inside `.game-wrapper`, before `<PlayDndContext>`), the Resume bar:

```tsx
        {meOnAutopilot && (
          <div className="autopilot-bar" role="status">
            <span>Your turn ran out, so a bot is playing for you.</span>
            <button type="button" className="btn btn-sm btn-warning" disabled={resumeMutation.isPending} onClick={() => resumeMutation.mutate()}>
              Resume
            </button>
          </div>
        )}
```

My own seat: if `my-seat` is rendered through `Seat` with `seatPropsFor(myPlayerId)` the new
props flow automatically; otherwise show my clock beside the hand:
`{clock?.playerIds.includes(myPlayerId) && <span className="seat-tag seat-clock">{formatClock(clock.remainingMs)}</span>}`.

Imports: `searchState`, `turnClock`, `formatClock` from `@fortytwo/client`; `isOnAutopilot`,
`matchMode` from `@fortytwo/rules`; `useNow` from `../match/useNow`; `useOnline` from
`../api/presence`.

CSS (same file as `.table-waiting`):

```css
.table-search {
  color: var(--brass);
  font: 600 0.95rem var(--font-ui);
}

.table-presence {
  color: var(--ink-muted);
  font: 0.85rem var(--font-ui);
}

.seat-away {
  color: var(--ink-muted);
}

.seat-clock {
  font-variant-numeric: tabular-nums;
  color: var(--brass);
}

/* Shown to a player whose Live turn ran out while a bot plays for them. */
.autopilot-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.75rem;
  background: rgba(201, 164, 92, 0.15);
  color: var(--bone);
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -w @fortytwo/web && npm run typecheck -w @fortytwo/web`
Expected: PASS. Existing tests building `SeatProps` by hand (Seat tests, if any) need
`away: false, clock: null` added.

- [ ] **Step 7: Commit**

```bash
git add cloudflare/apps/web/src
git commit -m "feat(web): Live search, turn clock and Resume on the match page"
```

---

### Task 11: Mobile lobby - Active/History and the New match sheet

**Files:**
- Create: `cloudflare/apps/mobile/src/components/NewMatchSheet.tsx`
- Create: `cloudflare/apps/mobile/src/api/presence.tsx`
- Modify: `cloudflare/apps/mobile/src/api/useMatchSocket.ts` (export `subscribeNetworkWake`, `useAppInForeground`)
- Modify: `cloudflare/apps/mobile/src/app/_layout.tsx`
- Modify: `cloudflare/apps/mobile/src/app/index.tsx`
- Test: `cloudflare/apps/mobile/src/components/__tests__/components.test.tsx`

**Interfaces:**
- Consumes: `api.play`, `api.createMatch`, `api.getConfig`; `rowStatus`, `yourTurnFirst`, `MODE_LABELS`, `connectPresenceSocket` (Task 8)
- Produces: `PresenceProvider({ enabled, children })` and `useOnline(): number | null` in `apps/mobile/src/api/presence.tsx`
- Produces: `NewMatchSheet({ visible, liveEnabled, online, pending, onChoose, onClose })` (`online: number | null`), `onChoose: (choice: 'live' | 'daily' | 'challenge') => void`

- [ ] **Step 1: Write the failing test** (append to `components.test.tsx`, importing `NewMatchSheet`)

```tsx
describe('NewMatchSheet', () => {
  it('offers Live, Daily and Challenge friends, and reports the choice', () => {
    const onChoose = jest.fn();
    render(<NewMatchSheet visible liveEnabled online={5} pending={false} onChoose={onChoose} onClose={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: /live/i }));
    fireEvent.press(screen.getByRole('button', { name: /daily/i }));
    fireEvent.press(screen.getByRole('button', { name: /challenge friends/i }));
    expect(onChoose.mock.calls).toEqual([['live'], ['daily'], ['challenge']]);
    expect(screen.getByText('5 online')).toBeTruthy();
  });

  it('leaves Live out when bots are off', () => {
    render(<NewMatchSheet visible liveEnabled={false} online={null} pending={false} onChoose={jest.fn()} onClose={jest.fn()} />);
    expect(screen.queryByRole('button', { name: /^live/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @fortytwo/mobile -- components`
Expected: FAIL - module not found.

- [ ] **Step 3: `NewMatchSheet.tsx`**

```tsx
// The New match chooser as a bottom sheet: Live and Daily go to matchmaking, Challenge friends
// sets up a table to share (a custom match). Live is left out while bots are off, since it relies
// on them to fill its seats.
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts } from '@/components/theme';

export type NewMatchChoice = 'live' | 'daily' | 'challenge';

const OPTIONS: { choice: NewMatchChoice; title: string; detail: string; icon: string }[] = [
  { choice: 'live', title: 'Live', detail: "Play now with whoever's around. Start with bots whenever you like.", icon: '⚡' },
  { choice: 'daily', title: 'Daily', detail: "Take your turns whenever. We'll notify you.", icon: '☀' },
  { choice: 'challenge', title: 'Challenge friends', detail: 'Set up a table and share the invite link.', icon: '✉' },
];

export function NewMatchSheet({
  visible,
  liveEnabled,
  online,
  pending,
  onChoose,
  onClose,
}: {
  visible: boolean;
  liveEnabled: boolean;
  // Players online (the presence socket), or null until the first count arrives.
  online: number | null;
  pending: boolean;
  onChoose: (choice: NewMatchChoice) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}>
        <View style={styles.grab} />
        <Text style={styles.title} accessibilityRole="header">New match</Text>
        {online !== null && <Text style={styles.online}>{online} online</Text>}
        {OPTIONS.filter((o) => liveEnabled || o.choice !== 'live').map((o) => (
          <Pressable
            key={o.choice}
            style={({ pressed }) => [styles.option, (pressed || pending) && styles.optionDim]}
            disabled={pending}
            onPress={() => onChoose(o.choice)}
            accessibilityRole="button"
            accessibilityLabel={`${o.title}. ${o.detail}`}
          >
            <View style={styles.icon}>
              <Text style={styles.iconText}>{o.icon}</Text>
            </View>
            <View style={styles.optionText}>
              <Text style={styles.optionTitle}>{o.title}</Text>
              <Text style={styles.optionDetail}>{o.detail}</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(10, 6, 4, 0.6)' },
  sheet: {
    backgroundColor: colors.walnutDeep,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    gap: 10,
  },
  grab: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(242, 234, 219, 0.25)' },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 22, marginBottom: 4 },
  online: { color: colors.brass, fontFamily: fonts.uiMedium, fontSize: 14, marginTop: -6, marginBottom: 4 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, backgroundColor: colors.mat },
  optionDim: { opacity: 0.6 },
  icon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.brass, alignItems: 'center', justifyContent: 'center' },
  iconText: { color: colors.walnutDeep, fontSize: 18 },
  optionText: { flex: 1 },
  optionTitle: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  optionDetail: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13, marginTop: 2 },
});
```

(`accessibilityLabel` starts with the title, so `getByRole('button', { name: /live/i })` matches
Live; the Daily detail doesn't contain "live". The "leaves Live out" test anchors with `^live`.)

- [ ] **Step 4: `api/presence.tsx`** - one presence socket while signed in and in front

Export `subscribeNetworkWake` and `useAppInForeground` from `api/useMatchSocket.ts` (they're
module-private today), then:

```tsx
// The online count, from one presence socket (@fortytwo/client's connectPresenceSocket) held while
// the player is signed in and the app is in the foreground - closed in the background, like the
// match socket, so a phone in a pocket doesn't count as online. A context, so every screen shares
// the one socket.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { connectPresenceSocket } from '@fortytwo/client';
import { config } from '@/config';
import { useGetToken } from '@/auth/useGetToken';
import { subscribeNetworkWake, useAppInForeground } from '@/api/useMatchSocket';

const OnlineContext = createContext<number | null>(null);

export function PresenceProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [online, setOnline] = useState<number | null>(null);
  const getToken = useGetToken();
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);
  const foreground = useAppInForeground();

  useEffect(() => {
    if (!enabled || !foreground) return;
    return connectPresenceSocket({
      origin: config.wsOrigin,
      getToken: () => getTokenRef.current(),
      onOnline: setOnline,
      subscribeWake: subscribeNetworkWake,
    });
  }, [enabled, foreground]);

  return <OnlineContext.Provider value={online}>{children}</OnlineContext.Provider>;
}

// Players with the app open, or null until the first count arrives.
export function useOnline(): number | null {
  return useContext(OnlineContext);
}
```

Use whatever hook `useMatchSocket`'s callers pass `getToken` from (`grep -rn "useMatchSocket(" apps/mobile/src`)
in place of `useGetToken` if the name differs. In `_layout.tsx`'s `RootStack`, wrap the returned
`<Stack>` in `<PresenceProvider enabled={signedIn && !DEV_BYPASS}>`.

- [ ] **Step 5: `app/index.tsx`**

- Header comment: replace "joining an open seat in someone else's" with "starting Live or Daily
  play, or a table to share".
- `type Filter = 'Active' | 'Completed';`, `FILTERS` without Joinable; Active empty state
  `{ title: 'No games yet', detail: 'Start a new match: play Live now, take Daily turns, or challenge friends.' }`; drop Joinable's entry.
- Remove `pickingSeatIn`, `join`, the `SeatPicker` import, `MatchRow`'s joinable branch and its
  `joinable`/`picking`/`onToggleJoin`/`joining`/`onPick` props and the `joinable*`/`join*`/`cancel*` styles.
- Replace `create` with:

```tsx
  const config = useQuery({ queryKey: ['config'], queryFn: () => api.getConfig() });
  const online = useOnline();
  const [choosing, setChoosing] = useState(false);
  // Live and Daily seat the player through matchmaking; Challenge friends starts a custom table.
  const start = useMutation({
    mutationFn: (choice: NewMatchChoice) => (choice === 'challenge' ? api.createMatch() : api.play(choice)),
    onSuccess: (match) => {
      setChoosing(false);
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      router.push(`/match/${match.id}`);
    },
    onError: toastError,
  });
```

  (Reuse the match screen's config query key if it differs - `grep -n "getConfig" apps/mobile/src -r`.)
- FAB `onPress={() => setChoosing(true)}`, spinner on `start.isPending`; render
  `<NewMatchSheet visible={choosing} liveEnabled={config.data?.bots ?? false} online={online} pending={start.isPending} onChoose={(c) => start.mutate(c)} onClose={() => setChoosing(false)} />` before the FAB.
- Empty-state link: text "New match", `onPress={() => setFilter... }` becomes `onPress={() => setChoosing(true)}`.
- `data={yourTurnFirst(uniqueMatches(matches.data?.pages) ?? [])}`.
- Delete the local `matchStatus`; in `MatchRow` use `const status = rowStatus(match);` and render

```tsx
        <Text style={[styles.rowStatus, status.yours && styles.rowStatusYours]}>
          {MODE_LABELS[match.mode]} · {status.text}
        </Text>
```

  with `rowStatusYours: { color: colors.brass, fontFamily: fonts.uiBold }` replacing
  `rowStatusWaiting`.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -w @fortytwo/mobile && npm run typecheck -w @fortytwo/mobile`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cloudflare/apps/mobile/src
git commit -m "feat(mobile): New match sheet, online count and your-turn lobby"
```

---

### Task 12: Mobile match screen - searching, Live clock, away and Resume

**Files:**
- Create: `cloudflare/apps/mobile/src/match/useNow.ts`
- Modify: `cloudflare/apps/mobile/src/app/match/[id].tsx`
- Modify: `cloudflare/apps/mobile/src/components/Table.tsx` (`SeatInfo`, seat plate)
- Test: `cloudflare/apps/mobile/src/components/__tests__/components.test.tsx` (Table)

**Interfaces:**
- Consumes: `searchState`, `turnClock`, `formatClock` (Task 8); `isOnAutopilot`, `matchMode` (Task 1); `api.resume` (Task 8)
- Produces: `SeatInfo` gains `away: boolean`, `clock: string | null`; `useNow(enabled, intervalMs?)`

- [ ] **Step 1: Write the failing test** (in the existing `describe('Table'` block that builds `SeatInfo`s; add `away: false, clock: null` to its seat fixture helper first)

```tsx
  it("shows a seat's Live clock and marks a player who's away", () => {
    const seats = {
      bottom: { ...seat('Me'), clock: '0:42' },
      left: { ...seat('Eli'), away: true },
      top: null,
      right: null,
    };
    render(<Table {...tableProps({ seats })} />);
    expect(screen.getByText('0:42')).toBeTruthy();
    expect(screen.getByText('Away')).toBeTruthy();
  });
```

(Use the file's existing Table fixture builders; `seat(...)`/`tableProps(...)` stand for whatever
they're called there.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @fortytwo/mobile -- components`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/match/useNow.ts` - identical to the web hook in Task 10 Step 3 (copy it; the apps don't
share React code).

`Table.tsx` `SeatInfo`:

```ts
  // On autopilot: a bot is playing for them after a Live turn ran out.
  away: boolean;
  // Time left on their Live turn ("0:42"), or null.
  clock: string | null;
```

In the seat plate, after the name text:

```tsx
          {info.away && <Text style={styles.seatAway}>Away</Text>}
          {info.clock !== null && <Text style={styles.seatClock}>{info.clock}</Text>}
```

styles: `seatAway: { color: colors.inkMuted, fontFamily: fonts.uiMedium, fontSize: 12 }`,
`seatClock: { color: colors.brass, fontFamily: fonts.uiBold, fontSize: 12, fontVariant: ['tabular-nums'] }`.
(Use the plate's actual prop name for the seat info if it isn't `info`.)

`[id].tsx`:
- Derived state and mutation next to `addBots`/`leave` (unconditional hooks):

```tsx
  const searchNow = match ? searchState(match, Date.now()) : null;
  const ticking = match != null && (searchNow?.mode === 'live' || turnClock(match, Date.now()) !== null);
  const now = useNow(ticking);
  const search = match ? searchState(match, now) : null;
  const clock = match ? turnClock(match, now) : null;
  const mode = match ? matchMode(match) : 'custom';
  const meOnAutopilot = match != null && myPlayerId != null && isOnAutopilot(match, myPlayerId);
  const resume = useMutation({ mutationFn: () => api.resume(id), onError: toastError });
  const online = useOnline();
```

- `seatInfo` returns also `away: isOnAutopilot(match!, playerId)` and
  `clock: clock?.playerIds.includes(playerId) ? formatClock(clock.remainingMs) : null`.
- In the `center` waiting view, first child:

```tsx
                {search?.mode === 'live' && (
                  <>
                    <Text style={styles.searchText} accessibilityRole="text">Finding players… {formatClock(search.elapsedMs)}</Text>
                    {online !== null && <Text style={styles.waitingText}>{online} online</Text>}
                    <Pressable
                      style={styles.smallButton}
                      disabled={!connected || addBots.isPending}
                      onPress={() => addBots.mutate()}
                      accessibilityRole="button"
                    >
                      <Text style={styles.smallButtonText}>Start now with bots</Text>
                    </Pressable>
                  </>
                )}
                {search?.mode === 'daily' && (
                  <Text style={styles.searchText}>Looking for players - we'll notify you when the table fills.</Text>
                )}
```

- Guard "Invite friends" and "Fill with bots" with `mode === 'custom' &&`.
- Leave button text: `mode === 'live' ? 'Cancel search' : onlyHumanSeated ? 'Cancel match' : 'Leave table'`;
  for Live, `onPress={() => { leavingRef.current = true; leave.mutate(); }}` (no confirm) - use
  whatever flag `confirmLeave` sets before `leave.mutate()`.
- Above the `<Table ... />`:

```tsx
        {meOnAutopilot && (
          <View style={styles.autopilotBar}>
            <Text style={styles.autopilotText}>Your turn ran out, so a bot is playing for you.</Text>
            <Pressable
              style={[styles.smallButton, resume.isPending && styles.buttonDisabled]}
              disabled={resume.isPending}
              onPress={() => resume.mutate()}
              accessibilityRole="button"
            >
              <Text style={styles.smallButtonText}>Resume</Text>
            </Pressable>
          </View>
        )}
```

  styles: `searchText: { color: colors.brass, fontFamily: fonts.uiBold, fontSize: 15, textAlign: 'center' }`,
  `autopilotBar: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 12, backgroundColor: 'rgba(201, 164, 92, 0.15)' }`,
  `autopilotText: { flex: 1, color: colors.bone, fontFamily: fonts.ui, fontSize: 14 }`.
- Imports: `searchState`, `turnClock`, `formatClock` from `@fortytwo/client`; `isOnAutopilot`,
  `matchMode` from `@fortytwo/rules`; `useNow` from `@/match/useNow`; `useOnline` from
  `@/api/presence`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -w @fortytwo/mobile && npm run typecheck -w @fortytwo/mobile`
Expected: PASS.

- [ ] **Step 5: Whole-repo check**

Run: `npm run typecheck && npm test`
Expected: every workspace passes.

- [ ] **Step 6: See it running**

Use the `mobile-emulator` skill to open the lobby, tap **New match**, and screenshot the sheet;
then pick Daily and screenshot the "Looking for players" table. For web, run the worker
(`npm run dev -w @fortytwo/worker`, with `BOTS_ENABLED` unset so Live shows) and the web dev
server, and check the New match dialog's online count, a Live search counting up, and Start now with bots.

- [ ] **Step 7: Commit**

```bash
git add cloudflare/apps/mobile/src
git commit -m "feat(mobile): Live search, turn clock and Resume on the match screen"
```

---

## After all tasks

- Remote D1 needs migration `0010` applied before the worker deploys
  (`npx wrangler d1 migrations apply fortytwo --remote` from `cloudflare/apps/worker`), and the
  `v2` DO migration ships with the deploy. The worker release workflow deploys on release-please
  merges (see the release-please memory) - check it applies D1 migrations; if not, apply by hand
  before merging the release PR.
- PR title: `feat: matchmaking - Live and Daily play from the lobby`, body linking #84, #123, #124, #126.
