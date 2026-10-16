# Recent players and friends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A People list (friends, recent players, name search) in the Lobby, one-way friends, and invites to a Custom Match sent from the table — as a push and as an "Invited to" card in the Lobby — on web and mobile.

**Architecture:** Three new D1 tables (`played_with`, `friends`, `invites`) behind new worker routes (`/api/people`, `/api/invites`, `POST /api/matches/:id/invites`). MatchDO records who played with whom when a game starts; the lobby index sync clears invites that no longer apply. The shared client package gets the API methods and one label helper; web and mobile each get a `src/people/` folder (hook, list, panel, invites card, invite dialog/sheet).

**Tech Stack:** Cloudflare Workers + D1 + Durable Objects, Hono, vitest (`@cloudflare/vitest-plugin` for the worker), React + TanStack Query (web, vitest + Testing Library), Expo / React Native (mobile, jest-expo + RN Testing Library), Expo push.

**Spec:** `docs/superpowers/specs/2026-10-14-recent-players-and-friends-design.md`

## Global Constraints

- All paths below are relative to `cloudflare/` unless they start with `docs/`.
- Migration file: `apps/worker/migrations/0012_people.sql`, starting with a `--` comment saying why.
- Only `custom` matches take invites. Invites per table: at most **6**; one per invitee per table.
- Friends are one-way; the other person is never told.
- `GET /api/people`: friends first (newest first), then recent players not already friends, at most **30** recent.
- Search: `q` trimmed, **2–40** characters, at most **20** results, excludes the caller.
- Invite push: title `"{name} invited you to a game"`, body `"Tap to pick a seat"`, `data.url = /match/{id}`, collapse id / tag `invite-{id}`, channel `game`, TTL **1 hour**.
- D1 writes from the match (played_with, invite cleanup) never fail a play: they run under `bestEffort` (`apps/worker/src/lobby.ts`).
- Refusals are `{ title, detail }` JSON with the stated status.
- Commit messages are conventional (`feat(worker): …`, `feat(web): …`, `feat(mobile): …`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worker tests need Node 25 if the run fails on Node 26 (vitest-pool-workers): `nvm use 25.7`.
- Mobile has no ESLint (issue #144): don't run `expo lint`.

## Review Focus

1. **A player invited who then takes a seat, or a table that fills** — the invite should vanish from their Lobby straight away. Pinned in Task 4 (`clears invites when the invitee sits` / `when the table fills`).
2. **Display names with `%`, `_` or mixed case in search** — "an" should find "Ann" and "ANNA", and `%` should not match everything. Pinned in Task 3 (`search is a case-insensitive prefix, with no wildcards`).
3. **Someone already friends with a recent player** — they appear once, under friends, not twice. Pinned in Task 3 (`lists friends first, without repeating them as recent`).
4. **Inviting someone the inviter can't see in the list** (a made-up id, a bot, someone already seated, yourself) — skipped, never pushed, and doesn't use up the 6. Pinned in Task 4 (`skips seated players, bots, yourself and unknown ids`).
5. **A rematch or a seat takeover** — counts as playing together; the takeover only adds the newcomer's pairs, and the "games" count doesn't double for the three who stayed. Pinned in Task 2 (`startedPlayers` tests).

---

### Task 1: Migration `0012_people.sql`

**Files:**
- Create: `apps/worker/migrations/0012_people.sql`
- Test: `apps/worker/test/migrations.people.test.ts`

**Interfaces:**
- Produces: tables `played_with(user_id, other_id, last_played_on, games)`, `friends(user_id, friend_id, created_on)`, `invites(match_id, to_id, from_id, created_on, dismissed)`; index `users_display_name`.

- [ ] **Step 1: Write the failing test**

`apps/worker/test/migrations.people.test.ts`:

```ts
// The 0012 migration's backfill of played_with from the lobby index. Migrations run once, before
// any test (applyMigrations.ts), so the backfill statement is re-run here against seeded rows.
import { beforeEach, describe, expect, it } from 'vitest';
import { env, type D1Migration } from 'cloudflare:test';
import type { Env } from '../src/index';

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: D1Migration[] };

function backfill(): string {
  const migration = testEnv.TEST_MIGRATIONS.find((m) => m.name.startsWith('0012_'));
  const query = migration?.queries.find((q) => q.includes('INSERT INTO played_with'));
  if (!query) throw new Error('0012 has no played_with backfill');
  return query;
}

async function seat(matchId: string, updatedOn: string, players: string[]) {
  await testEnv.DB.batch([
    testEnv.DB.prepare('INSERT INTO matches (id, status, player_count, updated_on) VALUES (?, ?, ?, ?)').bind(
      matchId,
      'completed',
      players.length,
      updatedOn
    ),
    ...players.map((id, position) =>
      testEnv.DB.prepare('INSERT INTO match_players (match_id, player_id, team, position) VALUES (?, ?, ?, ?)').bind(
        matchId,
        id,
        position % 2 === 0 ? 1 : 2,
        position
      )
    ),
  ]);
}

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM played_with'),
    testEnv.DB.prepare('DELETE FROM match_players'),
    testEnv.DB.prepare('DELETE FROM matches'),
  ]);
});

describe('0012 played_with backfill', () => {
  it('pairs every two humans at a full table, both ways, counting games and keeping the latest date', async () => {
    await seat('m1', '2026-10-01T00:00:00.000Z', ['ann', 'bo', 'cy', 'bot-1']);
    await seat('m2', '2026-10-05T00:00:00.000Z', ['ann', 'bo', 'bot-2', 'bot-3']);
    // Never filled, so nobody played.
    await seat('m3', '2026-10-06T00:00:00.000Z', ['ann', 'di']);

    await testEnv.DB.prepare(backfill()).run();

    const { results } = await testEnv.DB.prepare(
      'SELECT user_id, other_id, last_played_on, games FROM played_with ORDER BY user_id, other_id'
    ).all();
    expect(results).toEqual([
      { user_id: 'ann', other_id: 'bo', last_played_on: '2026-10-05T00:00:00.000Z', games: 2 },
      { user_id: 'ann', other_id: 'cy', last_played_on: '2026-10-01T00:00:00.000Z', games: 1 },
      { user_id: 'bo', other_id: 'ann', last_played_on: '2026-10-05T00:00:00.000Z', games: 2 },
      { user_id: 'bo', other_id: 'cy', last_played_on: '2026-10-01T00:00:00.000Z', games: 1 },
      { user_id: 'cy', other_id: 'ann', last_played_on: '2026-10-01T00:00:00.000Z', games: 1 },
      { user_id: 'cy', other_id: 'bo', last_played_on: '2026-10-01T00:00:00.000Z', games: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/worker`): `npx vitest run test/migrations.people.test.ts`
Expected: FAIL — `no such table: played_with` (or "0012 has no played_with backfill").

- [ ] **Step 3: Write the migration**

`apps/worker/migrations/0012_people.sql`:

```sql
-- Recent players, friends and invites (#116). played_with is who has sat at a started game with
-- whom, one row per direction, humans only - kept apart from match_players, whose rows go when a
-- match expires. friends are one-way stars. invites are to a custom table, until used or stale.
CREATE TABLE played_with (
  user_id TEXT NOT NULL,
  other_id TEXT NOT NULL,
  last_played_on TEXT NOT NULL,
  games INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, other_id)
);
CREATE INDEX played_with_recent ON played_with (user_id, last_played_on);

CREATE TABLE friends (
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  created_on TEXT NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

CREATE TABLE invites (
  match_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  created_on TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, to_id)
);
CREATE INDEX invites_to ON invites (to_id, created_on);

CREATE INDEX users_display_name ON users (display_name COLLATE NOCASE);

-- Everyone who shared a full table still in the lobby index. Expired matches are gone, so the
-- list starts from what's left.
INSERT INTO played_with (user_id, other_id, last_played_on, games)
SELECT a.player_id, b.player_id, MAX(m.updated_on), COUNT(*)
FROM match_players a
JOIN match_players b ON b.match_id = a.match_id AND b.player_id <> a.player_id
JOIN matches m ON m.id = a.match_id
WHERE m.player_count = 4 AND a.player_id NOT LIKE 'bot-%' AND b.player_id NOT LIKE 'bot-%'
GROUP BY a.player_id, b.player_id;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/migrations.people.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole worker suite** (the new tables must not break other tests)

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/migrations/0012_people.sql apps/worker/test/migrations.people.test.ts
git commit -m "feat(worker): tables for recent players, friends and invites"
```

---

### Task 2: Record who played with whom

**Files:**
- Create: `apps/worker/src/people/playedWith.ts`
- Modify: `apps/worker/src/matchDO.ts` (`publish`, ~line 572; imports ~line 46)
- Test: `apps/worker/test/playedWith.test.ts`

**Interfaces:**
- Consumes: `played_with` table (Task 1); `hasBeenDealt`, `isBot`, `MatchState` from `@fortytwo/rules`; `bestEffort` from `../lobby`.
- Produces:
  - `startedPlayers(previous: MatchState | null, next: MatchState): StartedTable | null`
  - `interface StartedTable { humans: string[]; newcomers: string[] | null }` (`newcomers` null = everyone is new)
  - `recordPlayedWith(db: D1Database, table: StartedTable, now: string): Promise<void>`

Note: the spec suggested sharing this check with `push/notices.ts`. That file's `justDealt` uses `isDealt`, which is about the current hand, not the first; keep notices untouched and use `hasBeenDealt` (true from the first deal for the rest of the match) here.

- [ ] **Step 1: Write the failing tests**

`apps/worker/test/playedWith.test.ts`:

```ts
// Who has played with whom (people/playedWith.ts): which changes count as a game starting, and
// the rows they write.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import { recordPlayedWith, startedPlayers } from '../src/people/playedWith';

const testEnv = env as unknown as Env;

// Just enough of a match for hasBeenDealt: a domino in each hand once dealt.
function table(ids: string[], dealt: boolean): MatchState {
  return {
    id: 'm1',
    players: ids.map((playerId, position) => ({ playerId, position, ready: true })),
    games: {},
    currentGame: { tricks: [], hands: ids.map((playerId) => ({ playerId, dominoes: dealt ? [{ top: 1, bottom: 2 }] : [] })) },
  } as unknown as MatchState;
}

describe('startedPlayers', () => {
  const four = ['ann', 'bo', 'cy', 'di'];

  it('counts the first deal, for every human', () => {
    expect(startedPlayers(table(four, false), table(four, true))).toEqual({ humans: four, newcomers: null });
  });

  it('counts a rematch, which arrives already dealt', () => {
    expect(startedPlayers(null, table(four, true))).toEqual({ humans: four, newcomers: null });
  });

  it('leaves bots out', () => {
    expect(startedPlayers(null, table(['ann', 'bot-1', 'bo', 'bot-3'], true))).toEqual({ humans: ['ann', 'bo'], newcomers: null });
  });

  it('counts only the newcomer when a seat is taken over in a game under way', () => {
    const before = table(['ann', 'bo', 'cy', 'bot-1'], true);
    const after = table(['ann', 'bo', 'cy', 'eve'], true);
    expect(startedPlayers(before, after)).toEqual({ humans: ['ann', 'bo', 'cy', 'eve'], newcomers: ['eve'] });
  });

  it('ignores every other change', () => {
    expect(startedPlayers(table(four, true), table(four, true))).toBeNull();
    expect(startedPlayers(table(['ann'], false), table(['ann', 'bo'], false))).toBeNull();
    expect(startedPlayers(null, table(['ann'], false))).toBeNull();
  });
});

describe('recordPlayedWith', () => {
  beforeEach(async () => {
    await testEnv.DB.prepare('DELETE FROM played_with').run();
  });

  async function rows() {
    const { results } = await testEnv.DB.prepare(
      'SELECT user_id, other_id, last_played_on, games FROM played_with ORDER BY user_id, other_id'
    ).all();
    return results;
  }

  it('writes each pair both ways and counts games', async () => {
    await recordPlayedWith(testEnv.DB, { humans: ['ann', 'bo'], newcomers: null }, '2026-10-01T00:00:00.000Z');
    await recordPlayedWith(testEnv.DB, { humans: ['ann', 'bo'], newcomers: null }, '2026-10-02T00:00:00.000Z');
    expect(await rows()).toEqual([
      { user_id: 'ann', other_id: 'bo', last_played_on: '2026-10-02T00:00:00.000Z', games: 2 },
      { user_id: 'bo', other_id: 'ann', last_played_on: '2026-10-02T00:00:00.000Z', games: 2 },
    ]);
  });

  it('writes only pairs with a newcomer', async () => {
    await recordPlayedWith(testEnv.DB, { humans: ['ann', 'bo', 'eve'], newcomers: ['eve'] }, '2026-10-03T00:00:00.000Z');
    expect((await rows()).map((r) => `${r.user_id}>${r.other_id}`)).toEqual(['ann>eve', 'bo>eve', 'eve>ann', 'eve>bo']);
  });

  it('writes nothing for a single human', async () => {
    await recordPlayedWith(testEnv.DB, { humans: ['ann'], newcomers: null }, '2026-10-03T00:00:00.000Z');
    expect(await rows()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/playedWith.test.ts`
Expected: FAIL — cannot resolve `../src/people/playedWith`.

- [ ] **Step 3: Implement `people/playedWith.ts`**

```ts
// The played_with table (migrations/0012_people.sql): who has sat at a started game with whom,
// for the People list's recent players. Written by MatchDO when a game starts - the first deal,
// a rematch, or a newcomer taking over a seat mid-game - so a table that never filled, or a game
// against bots alone, adds nobody.
import { hasBeenDealt, isBot, type MatchState } from '@fortytwo/rules';

export interface StartedTable {
  humans: string[];
  // Only these players are new to the table; null when everyone is.
  newcomers: string[] | null;
}

export function startedPlayers(previous: MatchState | null, next: MatchState): StartedTable | null {
  if (next.players.length < 4 || !hasBeenDealt(next)) return null;
  const humans = next.players.map((p) => p.playerId).filter((id) => !isBot(id));
  if (previous === null || !hasBeenDealt(previous)) return { humans, newcomers: null };
  const before = new Set(previous.players.map((p) => p.playerId));
  const newcomers = humans.filter((id) => !before.has(id));
  return newcomers.length > 0 ? { humans, newcomers } : null;
}

export async function recordPlayedWith(db: D1Database, { humans, newcomers }: StartedTable, now: string): Promise<void> {
  const fresh = newcomers === null ? null : new Set(newcomers);
  const pairs = humans.flatMap((a) =>
    humans.filter((b) => b !== a && (fresh === null || fresh.has(a) || fresh.has(b))).map((b) => [a, b] as const)
  );
  if (pairs.length === 0) return;
  await db.batch(
    pairs.map(([a, b]) =>
      db
        .prepare(
          `INSERT INTO played_with (user_id, other_id, last_played_on, games) VALUES (?1, ?2, ?3, 1)
           ON CONFLICT (user_id, other_id) DO UPDATE SET last_played_on = ?3, games = games + 1`
        )
        .bind(a, b, now)
    )
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/playedWith.test.ts`
Expected: PASS.

- [ ] **Step 5: Hook it into `MatchDO.publish`**

In `apps/worker/src/matchDO.ts`, add the import next to the other local imports:

```ts
import { recordPlayedWith, startedPlayers } from './people/playedWith';
```

and change `publish` to:

```ts
  private publish(previous: MatchState | null, next: MatchState, onTheWay: string[] = []): void {
    this.broadcast(next);
    const watching = this.watchingPlayers();
    for (const id of onTheWay) watching.add(id);
    const notices = noticesFor(previous, next, watching);
    if (notices.length > 0) this.ctx.waitUntil(sendNotices(this.env, notices));
    // A game starting: the People list's recent players (people/playedWith.ts).
    const started = startedPlayers(previous, next);
    if (started) this.ctx.waitUntil(bestEffort(next.id, () => recordPlayedWith(this.env.DB, started, next.updatedOn)));
  }
```

Also extend the comment above `publish` with: "…and, when a game starts, who played with whom."

- [ ] **Step 6: Add an end-to-end check in an existing DO test**

In `apps/worker/test/routes.matches.test.ts`, find the test around line 270 that seats p1–p4 and readies them up. Directly after the ready-up loop (`for (const token of [p1, p2, p3, p4]) await send(token, 'PATCH', '/players', { ready: true });`) add:

```ts
    // The game started, so each of them has played with the other three (people/playedWith.ts).
    await vi.waitFor(async () => {
      const { n } = (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM played_with WHERE user_id = ?')
        .bind('auth0|p1')
        .first<{ n: number }>())!;
      expect(n).toBe(3);
    });
```

Use whatever sub that test signs `p1` with (read the surrounding test; replace `'auth0|p1'` with it). Add `testEnv.DB.prepare('DELETE FROM played_with')` to that file's `beforeEach` batch.

- [ ] **Step 7: Run the worker suite**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/people/playedWith.ts apps/worker/src/matchDO.ts apps/worker/test/playedWith.test.ts apps/worker/test/routes.matches.test.ts
git commit -m "feat(worker): remember who played with whom when a game starts"
```

---

### Task 3: People routes — list, search, friends

**Files:**
- Modify: `packages/api-types/src/index.ts` (after `PublicUser`, ~line 101)
- Modify: `apps/worker/src/requestBody.ts` (add `userIdParam`, `searchQuery`)
- Create: `apps/worker/src/people/people.ts`
- Create: `apps/worker/src/routes/people.ts`
- Modify: `apps/worker/src/index.ts:119-121` (mount)
- Test: `apps/worker/test/routes.people.test.ts`

**Interfaces:**
- Consumes: tables from Task 1; `publicUsers(env, ids)` from `users/publicUsers.ts`; `saveUsers` for test setup.
- Produces:
  - `Person` type in `@fortytwo/api-types`: `PublicUser & { isFriend: boolean; lastPlayedOn: string | null; games: number }`
  - `listPeople(env: Env, userId: string): Promise<Person[]>`
  - `searchPeople(db: D1Database, userId: string, q: string): Promise<Person[]>`
  - `addFriend(db, userId, friendId, now?: Date)`, `removeFriend(db, userId, friendId)`
  - `userIdParam(value: string | undefined): string`, `searchQuery(value: string | undefined, min: number, max: number): string` in `requestBody.ts`
  - Routes: `GET /api/people`, `GET /api/people/search?q=`, `PUT|DELETE /api/people/friends/:userId`
  - Constants `RECENT_LIMIT = 30`, `SEARCH_LIMIT = 20`, `SEARCH_MIN = 2`, `SEARCH_MAX = 40` (exported from `people/people.ts`)

- [ ] **Step 1: Add the `Person` type**

In `packages/api-types/src/index.ts`, after the `PublicUser` line:

```ts
// Someone in the caller's People list (GET /api/people, /api/people/search): a friend they've
// starred, someone they've played with, or a search result. `games` and `lastPlayedOn` count
// started games together (0 and null if none).
export type Person = PublicUser & { isFriend: boolean; lastPlayedOn: string | null; games: number };
```

- [ ] **Step 2: Write the failing route tests**

`apps/worker/test/routes.people.test.ts`. Copy the JWT/JWKS/`api()` setup from `routes.users.test.ts` lines 1–61 (constants, `beforeAll`, `signToken`, `api`) with `KEY_ID = 'routes-people-test-key'`, then:

```ts
import { saveUsers } from '../src/users/publicUsers';
import type { Person } from '@fortytwo/api-types';

const testEnv = env as unknown as Env; // import type { Env } from '../src/index'

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM played_with'),
    testEnv.DB.prepare('DELETE FROM friends'),
    testEnv.DB.prepare('DELETE FROM users'),
  ]);
  await saveUsers(testEnv.DB, [
    { user_id: 'auth0|me', displayName: 'Me' },
    { user_id: 'auth0|ann', displayName: 'Ann' },
    { user_id: 'auth0|anna', displayName: 'ANNA' },
    { user_id: 'auth0|bo', displayName: 'Bo' },
    { user_id: 'auth0|pct', displayName: '100% Cy' },
  ]);
});

async function played(other: string, on: string, games = 1) {
  await testEnv.DB.prepare('INSERT INTO played_with (user_id, other_id, last_played_on, games) VALUES (?, ?, ?, ?)')
    .bind('auth0|me', other, on, games)
    .run();
}

const names = (people: Person[]) => people.map((p) => p.displayName);

describe('GET /api/people', () => {
  it('lists friends first, without repeating them as recent', async () => {
    await played('auth0|ann', '2026-10-01T00:00:00.000Z', 3);
    await played('auth0|bo', '2026-10-02T00:00:00.000Z');
    expect((await api('/api/people/friends/auth0%7Cann', 'auth0|me', { method: 'PUT' })).status).toBe(204);

    const people = (await (await api('/api/people', 'auth0|me')).json()) as Person[];
    expect(people).toEqual([
      { user_id: 'auth0|ann', displayName: 'Ann', isFriend: true, lastPlayedOn: '2026-10-01T00:00:00.000Z', games: 3 },
      { user_id: 'auth0|bo', displayName: 'Bo', isFriend: false, lastPlayedOn: '2026-10-02T00:00:00.000Z', games: 1 },
    ]);
  });

  it('lists recent players newest first', async () => {
    await played('auth0|ann', '2026-10-01T00:00:00.000Z');
    await played('auth0|bo', '2026-10-02T00:00:00.000Z');
    expect(names((await (await api('/api/people', 'auth0|me')).json()) as Person[])).toEqual(['Bo', 'Ann']);
  });

  it('is empty for someone new', async () => {
    expect(await (await api('/api/people', 'auth0|me')).json()).toEqual([]);
  });
});

describe('GET /api/people/search', () => {
  it('search is a case-insensitive prefix, with no wildcards', async () => {
    const found = async (q: string) =>
      names((await (await api(`/api/people/search?q=${encodeURIComponent(q)}`, 'auth0|me')).json()) as Person[]);
    expect(await found('an')).toEqual(['Ann', 'ANNA']);
    expect(await found('  ANN ')).toEqual(['Ann', 'ANNA']);
    expect(await found('%%')).toEqual([]);
    expect(await found('10')).toEqual(['100% Cy']);
  });

  it('leaves the caller out and marks friends', async () => {
    await api('/api/people/friends/auth0%7Cbo', 'auth0|me', { method: 'PUT' });
    const people = (await (await api('/api/people/search?q=Bo', 'auth0|me')).json()) as Person[];
    expect(people).toEqual([{ user_id: 'auth0|bo', displayName: 'Bo', isFriend: true, lastPlayedOn: null, games: 0 }]);
    expect(names((await (await api('/api/people/search?q=Me', 'auth0|me')).json()) as Person[])).toEqual([]);
  });

  it('refuses a query that is too short or too long', async () => {
    expect((await api('/api/people/search?q=a', 'auth0|me')).status).toBe(400);
    expect((await api('/api/people/search', 'auth0|me')).status).toBe(400);
    expect((await api(`/api/people/search?q=${'x'.repeat(41)}`, 'auth0|me')).status).toBe(400);
  });
});

describe('friends', () => {
  it('stars and unstars, idempotently', async () => {
    for (let i = 0; i < 2; i++) expect((await api('/api/people/friends/auth0%7Cbo', 'auth0|me', { method: 'PUT' })).status).toBe(204);
    expect((await (await api('/api/people', 'auth0|me')).json()) as Person[]).toHaveLength(1);
    for (let i = 0; i < 2; i++) expect((await api('/api/people/friends/auth0%7Cbo', 'auth0|me', { method: 'DELETE' })).status).toBe(204);
    expect(await (await api('/api/people', 'auth0|me')).json()).toEqual([]);
  });

  it('refuses yourself, a bot, and someone it has never seen', async () => {
    expect((await api('/api/people/friends/auth0%7Cme', 'auth0|me', { method: 'PUT' })).status).toBe(400);
    expect((await api('/api/people/friends/bot-1', 'auth0|me', { method: 'PUT' })).status).toBe(400);
    expect((await api('/api/people/friends/auth0%7Cnobody', 'auth0|me', { method: 'PUT' })).status).toBe(404);
  });

  it("doesn't tell the other person", async () => {
    await api('/api/people/friends/auth0%7Cbo', 'auth0|me', { method: 'PUT' });
    expect(await (await api('/api/people', 'auth0|bo')).json()).toEqual([]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/routes.people.test.ts`
Expected: FAIL — 404s (route not mounted).

- [ ] **Step 4: Add request checks to `requestBody.ts`**

Append:

```ts
// A user id from a route parameter (Hono has already URL-decoded it).
export function userIdParam(value: string | undefined): string {
  if (value === undefined || !USER_ID.test(value)) throw new BadRequestError('That is not a user id.');
  return value;
}

// A People search: trimmed, SEARCH_MIN to SEARCH_MAX characters.
export function searchQuery(value: string | undefined, min: number, max: number): string {
  const q = (value ?? '').trim();
  if ([...q].length < min || [...q].length > max) {
    throw new BadRequestError(`Search with ${min} to ${max} characters.`);
  }
  return q;
}
```

(`searchQuery` takes `min`/`max` so `requestBody.ts` does not import from `people/`.)

- [ ] **Step 5: Implement `people/people.ts`**

```ts
// The People list (GET /api/people) and its search: friends the caller has starred (friends,
// one-way - the other person isn't told), then people they've played with (played_with, written
// by MatchDO), named from the users table as the rest of the app does (users/publicUsers.ts).
import type { Person, PublicUser } from '@fortytwo/api-types';
import type { Env } from '../index';
import { publicUsers } from '../users/publicUsers';

export const RECENT_LIMIT = 30;
export const FRIENDS_LIMIT = 100;
export const SEARCH_LIMIT = 20;
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 40;

interface Row {
  id: string;
  is_friend: number;
  last_played_on: string | null;
  games: number | null;
}

function toPerson(user: PublicUser, row: Row): Person {
  return { ...user, isFriend: row.is_friend === 1, lastPlayedOn: row.last_played_on, games: row.games ?? 0 };
}

// Anyone the users table and Auth0 can't name is left out rather than failing the list.
export async function listPeople(env: Env, userId: string): Promise<Person[]> {
  const [friends, recent] = await env.DB.batch<Row>([
    env.DB.prepare(
      `SELECT f.friend_id AS id, 1 AS is_friend, pw.last_played_on, pw.games
       FROM friends f LEFT JOIN played_with pw ON pw.user_id = f.user_id AND pw.other_id = f.friend_id
       WHERE f.user_id = ?1 ORDER BY f.created_on DESC LIMIT ${FRIENDS_LIMIT}`
    ).bind(userId),
    env.DB.prepare(
      `SELECT pw.other_id AS id, 0 AS is_friend, pw.last_played_on, pw.games
       FROM played_with pw
       WHERE pw.user_id = ?1 AND NOT EXISTS (SELECT 1 FROM friends f WHERE f.user_id = ?1 AND f.friend_id = pw.other_id)
       ORDER BY pw.last_played_on DESC LIMIT ${RECENT_LIMIT}`
    ).bind(userId),
  ]);
  const rows = [...friends.results, ...recent.results];
  if (rows.length === 0) return [];
  const { users } = await publicUsers(env, rows.map((r) => r.id));
  const byId = new Map(users.map((u) => [u.user_id, u]));
  return rows.flatMap((row) => {
    const user = byId.get(row.id);
    return user ? [toPerson(user, row)] : [];
  });
}

// A case-insensitive prefix match on display names, as a range rather than LIKE so `%` and `_`
// in a name are just characters, and so it can use users_display_name (COLLATE NOCASE).
export async function searchPeople(db: D1Database, userId: string, q: string): Promise<Person[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.display_name, u.picture, (f.friend_id IS NOT NULL) AS is_friend, pw.last_played_on, pw.games
       FROM users u
       LEFT JOIN friends f ON f.user_id = ?1 AND f.friend_id = u.id
       LEFT JOIN played_with pw ON pw.user_id = ?1 AND pw.other_id = u.id
       WHERE u.display_name >= ?2 COLLATE NOCASE AND u.display_name < ?3 COLLATE NOCASE AND u.id <> ?1
       ORDER BY u.display_name COLLATE NOCASE LIMIT ${SEARCH_LIMIT}`
    )
    .bind(userId, q, `${q}￿`)
    .all<Row & { display_name: string; picture: string | null }>();
  return results.map((row) =>
    toPerson({ user_id: row.id, displayName: row.display_name, ...(row.picture != null && { picture: row.picture }) }, row)
  );
}

export async function isKnownUser(db: D1Database, id: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 FROM users WHERE id = ?1').bind(id).first()) !== null;
}

export async function addFriend(db: D1Database, userId: string, friendId: string, now: Date = new Date()): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_on) VALUES (?1, ?2, ?3)')
    .bind(userId, friendId, now.toISOString())
    .run();
}

export async function removeFriend(db: D1Database, userId: string, friendId: string): Promise<void> {
  await db.prepare('DELETE FROM friends WHERE user_id = ?1 AND friend_id = ?2').bind(userId, friendId).run();
}
```

Search order note: with `ORDER BY display_name COLLATE NOCASE`, "Ann" and "ANNA" compare as "ann" < "anna", so Ann comes first — matching the test.

- [ ] **Step 6: Implement `routes/people.ts` and mount it**

```ts
// Hono routes for the People list (people/people.ts): friends and recent players, a name search,
// and starring a friend.
import { Hono } from 'hono';
import { isBot } from '@fortytwo/rules';
import type { AppEnv } from '../index';
import { BadRequestError, searchQuery, userIdParam } from '../requestBody';
import { SEARCH_MAX, SEARCH_MIN, addFriend, isKnownUser, listPeople, removeFriend, searchPeople } from '../people/people';

const people = new Hono<AppEnv>();

people.get('/', async (c) => c.json(await listPeople(c.env, c.get('user').sub)));

people.get('/search', async (c) => {
  const q = searchQuery(c.req.query('q'), SEARCH_MIN, SEARCH_MAX);
  return c.json(await searchPeople(c.env.DB, c.get('user').sub, q));
});

people.put('/friends/:userId', async (c) => {
  const userId = c.get('user').sub;
  const friendId = userIdParam(c.req.param('userId'));
  if (friendId === userId) throw new BadRequestError("You can't add yourself as a friend.");
  if (isBot(friendId)) throw new BadRequestError("Bots can't be friends.");
  if (!(await isKnownUser(c.env.DB, friendId))) return c.json({ title: 'Not found', detail: 'No player with that id.' }, 404);
  await addFriend(c.env.DB, userId, friendId);
  return c.body(null, 204);
});

people.delete('/friends/:userId', async (c) => {
  await removeFriend(c.env.DB, c.get('user').sub, userIdParam(c.req.param('userId')));
  return c.body(null, 204);
});

export default people;
```

In `apps/worker/src/index.ts`, import `peopleRoutes from './routes/people'` beside the other route imports and add after `app.route('/api/users', usersRoutes);`:

```ts
app.route('/api/people', peopleRoutes);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/routes.people.test.ts`
Expected: PASS. If `'10'` doesn't find `'100% Cy'` or `'%%'` finds something, check the bounds are bound as text and the comparison uses `COLLATE NOCASE` on both sides.

- [ ] **Step 8: Typecheck and run the suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean, all pass.

- [ ] **Step 9: Commit**

```bash
git add packages/api-types/src/index.ts apps/worker/src/requestBody.ts apps/worker/src/people/people.ts apps/worker/src/routes/people.ts apps/worker/src/index.ts apps/worker/test/routes.people.test.ts
git commit -m "feat(worker): People list, name search and friends"
```

---

### Task 4: Invites — storage, routes, cleanup, push

**Files:**
- Modify: `packages/api-types/src/index.ts` (add `Invite`, `InviteResult`)
- Create: `apps/worker/src/people/invites.ts`
- Modify: `apps/worker/src/requestBody.ts` (add `invitees`)
- Modify: `apps/worker/src/lobby.ts` (`syncMatchPlayers` ~line 114, `deleteFromLobbyIndex` ~line 99)
- Modify: `apps/worker/src/routes/matches.ts` (new `POST /:id/invites`)
- Create: `apps/worker/src/routes/invites.ts`; mount in `apps/worker/src/index.ts`
- Modify: `apps/worker/src/push/notices.ts:30` (`NoticeKind` gains `'invite'`)
- Modify: `apps/worker/src/push/send.ts` (TTL entry, `inviteMessages`, `sendInvites`, shared `postMessages`)
- Test: `apps/worker/test/routes.invites.test.ts`, `apps/worker/test/push.send.test.ts`

**Interfaces:**
- Consumes: `invites`, `users` tables; `matchMode`, `isBot`, `MatchState` from `@fortytwo/rules`; `publicUsers`; `tokensFor`, `forgetTokens`.
- Produces:
  - `Invite` type: `{ matchId: string; from: PublicUser; createdOn: string; seatsOpen: number }`
  - `InviteResult` type: `{ invited: string[] }`
  - `MAX_INVITES_PER_TABLE = 6` (exported from `people/invites.ts`)
  - `createInvites(db, match: MatchState, fromId: string, toIds: string[], now?: Date): Promise<string[] | 'tooMany'>`
  - `listInvites(env, userId): Promise<Invite[]>`, `dismissInvite(db, userId, matchId)`
  - `inviteMessages(matchId: string, fromName: string, tokens: PushDevice[]): DrawnMessage[]`
  - `sendInvites(env: Env, matchId: string, fromName: string, toIds: string[]): Promise<void>`
  - `invitees(body, max: number): string[]` in `requestBody.ts`
  - Routes: `POST /api/matches/:id/invites` body `{ userIds }` → `InviteResult`; `GET /api/invites` → `Invite[]`; `DELETE /api/invites/:matchId` → 204

- [ ] **Step 1: Add the types**

In `packages/api-types/src/index.ts`, after `Person`:

```ts
// An invite to a custom table waiting for the caller (GET /api/invites), until they take a seat,
// dismiss it, or the table fills or ends.
export interface Invite {
  matchId: string;
  from: PublicUser;
  createdOn: string;
  seatsOpen: number;
}

// POST /api/matches/:id/invites: who was invited just now (anyone skipped is left out).
export interface InviteResult {
  invited: string[];
}
```

- [ ] **Step 2: Write the failing push test**

Append to `apps/worker/test/push.send.test.ts` (add `inviteMessages` to the `../src/push/send` import):

```ts
describe('inviteMessages', () => {
  it('names the inviter and opens the table', () => {
    const [message] = inviteMessages('m9', 'Ann', [{ token: 'ExponentPushToken[bo]', userId: 'bo', drawsOwn: true }]);
    expect(message).toEqual({
      to: 'ExponentPushToken[bo]',
      title: 'Ann invited you to a game',
      body: 'Tap to pick a seat',
      data: { url: '/match/m9' },
      sound: 'default',
      priority: 'high',
      channelId: 'game',
      collapseId: 'invite-m9',
      tag: 'invite-m9',
      ttl: 60 * 60,
    });
  });
});
```

- [ ] **Step 3: Write the failing route tests**

`apps/worker/test/routes.invites.test.ts`. Copy the JWT setup from `routes.users.test.ts` lines 1–61 (`KEY_ID = 'routes-invites-test-key'`), plus:

```ts
import { vi } from 'vitest';
import { saveUsers } from '../src/users/publicUsers';
import type { Invite, InviteResult } from '@fortytwo/api-types';
import type { MatchState } from '@fortytwo/rules';

const testEnv = env as unknown as Env;
const ME = 'auth0|me';

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM invites'),
    testEnv.DB.prepare('DELETE FROM match_players'),
    testEnv.DB.prepare('DELETE FROM matches'),
    testEnv.DB.prepare('DELETE FROM users'),
    testEnv.DB.prepare('DELETE FROM push_tokens'),
  ]);
  await saveUsers(testEnv.DB, ['me', 'ann', 'bo', 'cy', 'di', 'eve', 'fay', 'gus', 'hal'].map((n) => ({ user_id: `auth0|${n}`, displayName: n })));
});

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

async function customTable(): Promise<MatchState> {
  return (await (await api('/api/matches', ME, { method: 'POST' })).json()) as MatchState;
}

async function sit(matchId: string, sub: string, position: number) {
  const res = await api(`/api/matches/${matchId}/players`, sub, json({ position }));
  expect(res.status).toBe(200);
}

async function invite(matchId: string, userIds: string[], sub = ME) {
  return api(`/api/matches/${matchId}/invites`, sub, json({ userIds }));
}

async function myInvites(sub: string): Promise<Invite[]> {
  return (await (await api('/api/invites', sub)).json()) as Invite[];
}

describe('POST /api/matches/:id/invites', () => {
  it('invites people, who then see it in their Lobby', async () => {
    const match = await customTable();
    const res = await invite(match.id, ['auth0|ann', 'auth0|bo']);
    expect(res.status).toBe(200);
    expect(((await res.json()) as InviteResult).invited).toEqual(['auth0|ann', 'auth0|bo']);
    expect(await myInvites('auth0|ann')).toEqual([
      { matchId: match.id, from: { user_id: ME, displayName: 'me' }, createdOn: expect.any(String), seatsOpen: 3 },
    ]);
  });

  it('skips seated players, bots, yourself and unknown ids', async () => {
    const match = await customTable();
    await sit(match.id, 'auth0|ann', 1);
    const res = await invite(match.id, ['auth0|ann', 'bot-1', ME, 'auth0|nobody', 'auth0|bo']);
    expect(((await res.json()) as InviteResult).invited).toEqual(['auth0|bo']);
  });

  it('invites each person once per table', async () => {
    const match = await customTable();
    await invite(match.id, ['auth0|ann']);
    expect(((await (await invite(match.id, ['auth0|ann'])).json()) as InviteResult).invited).toEqual([]);
  });

  it('stops at six invites a table', async () => {
    const match = await customTable();
    await invite(match.id, ['auth0|ann', 'auth0|bo', 'auth0|cy', 'auth0|di', 'auth0|eve']);
    const res = await invite(match.id, ['auth0|fay', 'auth0|gus']);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { title: string }).title).toBe('Too many invites');
    expect(((await (await invite(match.id, ['auth0|fay'])).json()) as InviteResult).invited).toEqual(['auth0|fay']);
  });

  it('refuses someone not at the table', async () => {
    const match = await customTable();
    expect((await invite(match.id, ['auth0|bo'], 'auth0|ann')).status).toBe(403);
  });

  it('refuses a table that is not a Custom Match', async () => {
    const res = await api('/api/matches/bots', ME, { method: 'POST' });
    if (res.status === 404) return; // bots off in this environment
    const match = (await res.json()) as MatchState;
    expect((await invite(match.id, ['auth0|ann'])).status).toBe(409);
  });

  it('refuses a body without user ids', async () => {
    const match = await customTable();
    expect((await api(`/api/matches/${match.id}/invites`, ME, json({ userIds: [] }))).status).toBe(400);
    expect((await api(`/api/matches/${match.id}/invites`, ME, json({}))).status).toBe(400);
  });
});

describe('invite cleanup', () => {
  it('clears invites when the invitee sits', async () => {
    const match = await customTable();
    await invite(match.id, ['auth0|ann', 'auth0|bo']);
    await sit(match.id, 'auth0|ann', 1);
    expect(await myInvites('auth0|ann')).toEqual([]);
    expect((await myInvites('auth0|bo'))[0].seatsOpen).toBe(2);
  });

  it('clears every invite when the table fills', async () => {
    const match = await customTable();
    await invite(match.id, ['auth0|eve']);
    await sit(match.id, 'auth0|ann', 1);
    await sit(match.id, 'auth0|bo', 2);
    await sit(match.id, 'auth0|cy', 3);
    expect(await myInvites('auth0|eve')).toEqual([]);
    const { n } = (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE match_id = ?').bind(match.id).first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it('clears invites when the match is deleted', async () => {
    const match = await customTable();
    await invite(match.id, ['auth0|ann']);
    // The creator leaving an empty table deletes it.
    expect((await api(`/api/matches/${match.id}/players`, ME, { method: 'DELETE' })).status).toBeLessThan(300);
    expect(await myInvites('auth0|ann')).toEqual([]);
  });

  it('hides an invite to a table that has ended, even if cleanup missed it', async () => {
    const match = await customTable();
    await invite(match.id, ['auth0|ann']);
    await testEnv.DB.prepare("UPDATE matches SET status = 'completed' WHERE id = ?").bind(match.id).run();
    expect(await myInvites('auth0|ann')).toEqual([]);
  });

  it('dismisses an invite, and it is not sent again', async () => {
    const match = await customTable();
    await invite(match.id, ['auth0|ann']);
    expect((await api(`/api/invites/${match.id}`, 'auth0|ann', { method: 'DELETE' })).status).toBe(204);
    expect(await myInvites('auth0|ann')).toEqual([]);
    expect(((await (await invite(match.id, ['auth0|ann'])).json()) as InviteResult).invited).toEqual([]);
  });
});
```

Before relying on `DELETE /api/matches/:id/players` deleting the match, read `routes.matches.test.ts` around line 479 to confirm a lone creator leaving deletes it; adjust the assertion to match the status it returns.

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run test/routes.invites.test.ts test/push.send.test.ts`
Expected: FAIL — `inviteMessages` is not exported; invite routes 404.

- [ ] **Step 5: Push — `notices.ts` and `send.ts`**

`apps/worker/src/push/notices.ts:30`:

```ts
export type NoticeKind = 'turn' | 'handOver' | 'matchOver' | 'started' | 'poke' | 'invite';
```

In `apps/worker/src/push/send.ts`:

1. Add to `TTL_SECONDS`: `invite: 1 * HOUR,` and extend its comment: "An invite to a table is stale within the hour; the Lobby's Invited to card still shows it."
2. Pull the batching loop out of `sendNotices` into:

```ts
// Sends messages to Expo in batches, forgetting tokens it says are no longer registered.
async function postMessages(env: Env, messages: ExpoMessage[]): Promise<void> {
  const unregistered: string[] = [];
  for (let i = 0; i < messages.length; i += MAX_MESSAGES_PER_REQUEST) {
    // ...the existing loop body, unchanged...
  }
  await forgetTokens(env.DB, unregistered);
}
```

and make `sendNotices` call `await postMessages(env, messagesFor(notices, tokens, names));` inside its existing `try`.

3. Add:

```ts
// An invite to a custom table (POST /api/matches/:id/invites). Not about a change to the match,
// so it's sent on its own rather than worked out by notices.ts; no buttons, so drawn the same on
// every device.
export function inviteMessages(matchId: string, fromName: string, tokens: PushDevice[]): DrawnMessage[] {
  const tag = `invite-${matchId}`;
  return tokens.map((device) => ({
    to: device.token,
    title: `${fromName} invited you to a game`,
    body: 'Tap to pick a seat',
    data: { url: `/match/${matchId}` },
    sound: 'default',
    priority: 'high',
    channelId: ANDROID_CHANNEL_ID,
    collapseId: tag,
    tag,
    ttl: TTL_SECONDS.invite,
  }));
}

export async function sendInvites(env: Env, matchId: string, fromName: string, toIds: string[]): Promise<void> {
  if (toIds.length === 0) return;
  try {
    const tokens = await tokensFor(env.DB, toIds);
    if (tokens.length > 0) await postMessages(env, inviteMessages(matchId, fromName, tokens));
  } catch (err) {
    console.error('Sending invite notifications failed', err);
  }
}
```

Run: `npx vitest run test/push.send.test.ts` — Expected: PASS (including the existing tests, which prove the refactor kept `sendNotices` working).

- [ ] **Step 6: `requestBody.ts` — `invitees`**

```ts
// POST /api/matches/:id/invites: `{ userIds }`, 1 to `max` user ids, de-duplicated.
export function invitees(body: Body, max: number): string[] {
  const ids = body.userIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string' && USER_ID.test(id))) {
    throw new BadRequestError('`userIds` must be a list of user ids.');
  }
  const unique = [...new Set(ids as string[])];
  if (unique.length > max) throw new BadRequestError(`Invite at most ${max} players at a time.`);
  return unique;
}
```

(Takes `max` so `requestBody.ts` does not import from `people/`.)

- [ ] **Step 7: `people/invites.ts`**

```ts
// The invites table (migrations/0012_people.sql): invites to a custom table, sent from the table
// (POST /api/matches/:id/invites) and listed in the invitee's Lobby (GET /api/invites). An invite
// reserves nothing - custom tables stay open to anyone (#84 would change that). It's deleted when
// the invitee sits or the table fills (lobby.ts's syncMatchPlayers) or goes (deleteFromLobbyIndex),
// and the list also hides any to a table that's no longer open, in case that cleanup was missed.
import type { Invite, PublicUser } from '@fortytwo/api-types';
import { isBot, type MatchState } from '@fortytwo/rules';
import type { Env } from '../index';
import { publicUsers } from '../users/publicUsers';

export const MAX_INVITES_PER_TABLE = 6;
const INVITES_LIMIT = 20;

// Stores invites to `toIds`, leaving out anyone seated, bots, the inviter, ids the users table
// doesn't know, and anyone already invited to this table (dismissed or not). Returns who was
// invited, or 'tooMany' if they'd take the table past MAX_INVITES_PER_TABLE.
export async function createInvites(
  db: D1Database,
  match: MatchState,
  fromId: string,
  toIds: string[],
  now: Date = new Date()
): Promise<string[] | 'tooMany'> {
  const seated = new Set(match.players.map((p) => p.playerId));
  const candidates = toIds.filter((id) => !seated.has(id) && !isBot(id) && id !== fromId);
  const { results: existing } = await db
    .prepare('SELECT to_id FROM invites WHERE match_id = ?1')
    .bind(match.id)
    .all<{ to_id: string }>();
  const already = new Set(existing.map((r) => r.to_id));
  const fresh = candidates.filter((id) => !already.has(id));
  if (fresh.length === 0) return [];
  const placeholders = fresh.map((_, i) => `?${i + 1}`).join(', ');
  const { results: known } = await db
    .prepare(`SELECT id FROM users WHERE id IN (${placeholders})`)
    .bind(...fresh)
    .all<{ id: string }>();
  const knownIds = new Set(known.map((r) => r.id));
  const invited = fresh.filter((id) => knownIds.has(id));
  if (invited.length === 0) return [];
  if (existing.length + invited.length > MAX_INVITES_PER_TABLE) return 'tooMany';
  await db.batch(
    invited.map((id) =>
      db
        .prepare('INSERT OR IGNORE INTO invites (match_id, to_id, from_id, created_on) VALUES (?1, ?2, ?3, ?4)')
        .bind(match.id, id, fromId, now.toISOString())
    )
  );
  return invited;
}

export async function listInvites(env: Env, userId: string): Promise<Invite[]> {
  const { results } = await env.DB.prepare(
    `SELECT i.match_id, i.from_id, i.created_on, m.player_count
     FROM invites i JOIN matches m ON m.id = i.match_id
     WHERE i.to_id = ?1 AND i.dismissed = 0 AND m.status = 'active' AND m.player_count < 4
     ORDER BY i.created_on DESC LIMIT ${INVITES_LIMIT}`
  )
    .bind(userId)
    .all<{ match_id: string; from_id: string; created_on: string; player_count: number }>();
  if (results.length === 0) return [];
  const { users } = await publicUsers(env, results.map((r) => r.from_id));
  const byId = new Map(users.map((u) => [u.user_id, u]));
  return results.map((r) => ({
    matchId: r.match_id,
    from: byId.get(r.from_id) ?? ({ user_id: r.from_id, displayName: 'A player' } satisfies PublicUser),
    createdOn: r.created_on,
    seatsOpen: 4 - r.player_count,
  }));
}

// Kept, marked dismissed, so the table can't send it again.
export async function dismissInvite(db: D1Database, userId: string, matchId: string): Promise<void> {
  await db.prepare('UPDATE invites SET dismissed = 1 WHERE match_id = ?1 AND to_id = ?2').bind(matchId, userId).run();
}
```

- [ ] **Step 8: Cleanup in `lobby.ts`**

`deleteFromLobbyIndex` — add a first statement to the batch:

```ts
    db.prepare('DELETE FROM invites WHERE match_id = ?').bind(matchId),
```

and update its comment: "Drops a deleted match from the lobby: its invites and seats first, then the match row."

`syncMatchPlayers` — after building `statements`, before `db.batch`:

```ts
  // Invites end once the invitee is seated, or for everyone once the table is full (people/invites.ts).
  statements.push(
    players.length >= 4
      ? db.prepare('DELETE FROM invites WHERE match_id = ?').bind(matchId)
      : db
          .prepare('DELETE FROM invites WHERE match_id = ?1 AND to_id IN (SELECT player_id FROM match_players WHERE match_id = ?1)')
          .bind(matchId)
  );
```

(`const statements` is already an array; it may need `const statements: D1PreparedStatement[] = [...]`.)

- [ ] **Step 9: Routes**

In `apps/worker/src/routes/matches.ts`, after the `POST /:id/players` route, add (imports: `matchMode` from `@fortytwo/rules`; `createInvites, MAX_INVITES_PER_TABLE` from `../people/invites`; `sendInvites` from `../push/send`; `InviteResult` type from `@fortytwo/api-types`):

```ts
// Invites people to a custom table with an open seat (people/invites.ts), by push and in their
// Lobby. Only a player at the table may send them.
matches.post('/:id/invites', async (c) => {
  const userId = c.get('user').sub;
  const toIds = field.invitees(await readBody(c), MAX_INVITES_PER_TABLE);
  const result = await matchStub(c.env, c.req.param('id')).getMatch();
  if (!result.ok) return refusal(c, result);
  const match = result.value;
  if (!match.players.some((p) => p.playerId === userId)) {
    return c.json({ title: 'Not at this table', detail: 'Only players at the table can invite.' }, 403);
  }
  if (matchMode(match) !== 'custom') {
    return c.json({ title: "Can't invite here", detail: 'Only Custom Matches take invites.' }, 409);
  }
  if (match.winningTeam !== null) return c.json({ title: 'Match over', detail: 'This match has finished.' }, 409);
  if (match.players.length >= 4) return c.json({ title: 'Table is full', detail: 'Every seat is taken.' }, 409);
  const invited = await createInvites(c.env.DB, match, userId, toIds);
  if (invited === 'tooMany') {
    return c.json({ title: 'Too many invites', detail: `A table can send at most ${MAX_INVITES_PER_TABLE} invites.` }, 409);
  }
  if (invited.length > 0) {
    const { users } = await publicUsers(c.env, [userId]);
    c.executionCtx.waitUntil(sendInvites(c.env, match.id, users[0]?.displayName ?? 'A player', invited));
  }
  return c.json({ invited } satisfies InviteResult);
});
```

`apps/worker/src/routes/invites.ts`:

```ts
// Hono routes for the invites waiting for the caller (people/invites.ts): the Lobby's Invited to card.
import { Hono } from 'hono';
import type { AppEnv } from '../index';
import { dismissInvite, listInvites } from '../people/invites';

const invites = new Hono<AppEnv>();

invites.get('/', async (c) => c.json(await listInvites(c.env, c.get('user').sub)));

invites.delete('/:matchId', async (c) => {
  await dismissInvite(c.env.DB, c.get('user').sub, c.req.param('matchId'));
  return c.body(null, 204);
});

export default invites;
```

Mount in `index.ts` after the people route: `app.route('/api/invites', invitesRoutes);`

- [ ] **Step 10: Run tests**

Run: `npx vitest run test/routes.invites.test.ts test/push.send.test.ts test/lobby.test.ts`
Expected: PASS. If the push in `POST /invites` hits the network in tests, the users have no push tokens (deleted in `beforeEach`), so `sendInvites` returns before fetching.

- [ ] **Step 11: Typecheck and full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean, all pass.

- [ ] **Step 12: Commit**

```bash
git add packages/api-types/src/index.ts apps/worker/src apps/worker/test/routes.invites.test.ts apps/worker/test/push.send.test.ts
git commit -m "feat(worker): invite people to a custom table by push and in the Lobby"
```

---

### Task 5: Client API methods and the person label

**Files:**
- Modify: `packages/client/src/api.ts` (types import; methods at the end of the returned object)
- Create: `packages/client/src/people.ts`, `packages/client/src/people.test.ts`
- Modify: `packages/client/src/index.ts` (export `./people`)
- Test: `packages/client/src/api.test.ts`

**Interfaces:**
- Consumes: `Person`, `Invite`, `InviteResult` from `@fortytwo/api-types`.
- Produces (on the object `createApiClient` returns):
  - `getPeople(): Promise<Person[]>`
  - `searchPeople(q: string): Promise<Person[]>`
  - `addFriend(userId: string): Promise<void>`, `removeFriend(userId: string): Promise<void>`
  - `invitePlayers(matchId: string, userIds: string[]): Promise<InviteResult>`
  - `getInvites(): Promise<Invite[]>`, `dismissInvite(matchId: string): Promise<void>`
  - Re-exported types `Person`, `Invite`, `InviteResult` from `@fortytwo/client`
  - `personDetail(person: Person, now?: number): string`

- [ ] **Step 1: Failing tests**

`packages/client/src/people.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { personDetail } from './people';

const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const person = (p: Partial<Parameters<typeof personDetail>[0]>) => ({
  user_id: 'u',
  displayName: 'Ann',
  isFriend: false,
  lastPlayedOn: null,
  games: 0,
  ...p,
});

describe('personDetail', () => {
  it('says how many games and how long ago', () => {
    expect(personDetail(person({ games: 3, lastPlayedOn: '2026-10-12T12:00:00.000Z' }), NOW)).toBe('3 games · 2d ago');
    expect(personDetail(person({ games: 1, lastPlayedOn: '2026-10-14T09:00:00.000Z' }), NOW)).toBe('1 game · 3h ago');
    expect(personDetail(person({ games: 1, lastPlayedOn: '2026-10-14T11:59:30.000Z' }), NOW)).toBe('1 game · just now');
  });

  it('says Friend for a friend', () => {
    expect(personDetail(person({ isFriend: true, games: 2, lastPlayedOn: '2026-10-12T12:00:00.000Z' }), NOW)).toBe('Friend · 2 games');
    expect(personDetail(person({ isFriend: true }), NOW)).toBe('Friend');
  });

  it('says nothing for a stranger from search', () => {
    expect(personDetail(person({}), NOW)).toBe('');
  });
});
```

Append to `packages/client/src/api.test.ts`:

```ts
describe('people and invites', () => {
  it('sends each to its route', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = createApiClient(async () => 'token', 'https://w');

    await api.getPeople();
    await api.searchPeople('An n');
    await api.addFriend('auth0|a/b');
    await api.removeFriend('auth0|a');
    await api.invitePlayers('m1', ['auth0|a']);
    await api.getInvites();
    await api.dismissInvite('m1');

    const calls = fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit).method ?? 'GET'} ${url as string}`);
    expect(calls).toEqual([
      'GET https://w/api/people',
      'GET https://w/api/people/search?q=An%20n',
      'PUT https://w/api/people/friends/auth0%7Ca%2Fb',
      'DELETE https://w/api/people/friends/auth0%7Ca',
      'POST https://w/api/matches/m1/invites',
      'GET https://w/api/invites',
      'DELETE https://w/api/invites/m1',
    ]);
    expect(JSON.parse((fetchMock.mock.calls[4][1] as RequestInit).body as string)).toEqual({ userIds: ['auth0|a'] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (from `packages/client`): `npx vitest run src/people.test.ts src/api.test.ts`
Expected: FAIL — module `./people` not found; `api.getPeople` is not a function.

- [ ] **Step 3: Implement**

`packages/client/src/people.ts`:

```ts
// What the People list says under a name: how many games together and how recently, or that
// they're a friend. Shared by the web and mobile lists.
import type { Person } from '@fortytwo/api-types';

function ago(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (60 * 24))}d ago`;
}

export function personDetail(person: Person, now: number = Date.now()): string {
  const games = person.games === 1 ? '1 game' : `${person.games} games`;
  if (person.isFriend) return person.games > 0 ? `Friend · ${games}` : 'Friend';
  if (person.games === 0 || person.lastPlayedOn === null) return '';
  return `${games} · ${ago(person.lastPlayedOn, now)}`;
}
```

In `packages/client/src/index.ts` add `export * from './people';`.

In `packages/client/src/api.ts`: add `Invite, InviteResult, Person` to the `@fortytwo/api-types` import and to the `export type { … }` line; append to the returned object (after `removePushToken`):

```ts
    // The People list: friends, then recent players (GET /api/people).
    getPeople: (): Promise<Person[]> => request<Person[]>('/api/people'),

    // Players whose name starts with `q` (2-40 characters).
    searchPeople: (q: string): Promise<Person[]> =>
      request<Person[]>(`/api/people/search?q=${encodeURIComponent(q)}`),

    // Friends are one-way: the other player isn't told.
    addFriend: (userId: string): Promise<void> =>
      request<void>(`/api/people/friends/${encodeURIComponent(userId)}`, { method: 'PUT' }, false),

    removeFriend: (userId: string): Promise<void> =>
      request<void>(`/api/people/friends/${encodeURIComponent(userId)}`, { method: 'DELETE' }, false),

    // Invites players to a custom table the caller is seated at; resolves with who was invited.
    invitePlayers: (matchId: string, userIds: string[]): Promise<InviteResult> =>
      request<InviteResult>(`/api/matches/${matchId}/invites`, { method: 'POST', body: JSON.stringify({ userIds }) }),

    // Invites waiting for the caller, for the Lobby's Invited to card.
    getInvites: (): Promise<Invite[]> => request<Invite[]>('/api/invites'),

    dismissInvite: (matchId: string): Promise<void> =>
      request<void>(`/api/invites/${matchId}`, { method: 'DELETE' }, false),
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc -b`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src
git commit -m "feat(client): People and invites API methods"
```

---

### Task 6: Web — People tab and Invited to card in the Lobby

**Files:**
- Modify: `apps/web/src/api/client.ts` (re-export `Person`, `Invite`)
- Create: `apps/web/src/people/usePeople.ts`
- Create: `apps/web/src/people/PeoplePanel.tsx`, `apps/web/src/people/People.css`
- Create: `apps/web/src/people/InvitesCard.tsx`
- Create: `apps/web/src/people/PeoplePanel.test.tsx`
- Modify: `apps/web/src/pages/Lobby.tsx`, `apps/web/src/pages/Lobby.test.tsx`

**Interfaces:**
- Consumes: client methods from Task 5; `personDetail` from `@fortytwo/client`.
- Produces:
  - `type PeopleClient = Pick<ReturnType<typeof apiClient>, 'getPeople' | 'searchPeople' | 'addFriend' | 'removeFriend'>`
  - `usePeople(client: PeopleClient, query: string): { list: Person[] | undefined; loading: boolean; error: unknown; searching: boolean; toggleFriend: (p: Person) => void }`
  - `PeoplePanel({ client, hiddenIds?, action?, emptyText }: { client: PeopleClient; hiddenIds?: string[]; action?: (p: Person) => ReactNode; emptyText: string })`
  - `InvitesCard({ client }: { client: Pick<ReturnType<typeof apiClient>, 'getInvites' | 'dismissInvite'> })`
  - Query keys: `['people']`, `['people', 'search', q]`, `['invites']`

- [ ] **Step 1: Failing component tests**

`apps/web/src/people/PeoplePanel.test.tsx`:

```tsx
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Invite, Person } from '@fortytwo/client';
import { PeoplePanel } from './PeoplePanel';
import { InvitesCard } from './InvitesCard';

const ann: Person = { user_id: 'ann', displayName: 'Ann', isFriend: true, lastPlayedOn: null, games: 0 };
const bo: Person = { user_id: 'bo', displayName: 'Bo', isFriend: false, lastPlayedOn: '2026-10-12T00:00:00.000Z', games: 2 };

function client(people: Person[] = [ann, bo]) {
  return {
    getPeople: vi.fn(async () => people),
    searchPeople: vi.fn(async (q: string) => people.filter((p) => p.displayName.toLowerCase().startsWith(q.toLowerCase()))),
    addFriend: vi.fn(async () => {}),
    removeFriend: vi.fn(async () => {}),
  };
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PeoplePanel', () => {
  it('lists friends and recent players, starring and unstarring', async () => {
    const c = client();
    wrap(<PeoplePanel client={c} emptyText="Nobody yet" />);
    expect(await screen.findByText('Ann')).toBeTruthy();
    expect(screen.getByText(/2 games/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ann from friends' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Bo as a friend' }));
    await waitFor(() => expect(c.removeFriend).toHaveBeenCalledWith('ann'));
    expect(c.addFriend).toHaveBeenCalledWith('bo');
  });

  it('searches once two characters are typed', async () => {
    const c = client();
    wrap(<PeoplePanel client={c} emptyText="Nobody yet" />);
    await screen.findByText('Ann');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a player' }), { target: { value: 'bo' } });
    await waitFor(() => expect(c.searchPeople).toHaveBeenCalledWith('bo'));
    await waitFor(() => expect(screen.queryByText('Ann')).toBeNull());
  });

  it('hides people and shows an action for each', async () => {
    wrap(<PeoplePanel client={client()} hiddenIds={['ann']} action={(p) => <button>Invite {p.displayName}</button>} emptyText="x" />);
    expect(await screen.findByRole('button', { name: 'Invite Bo' })).toBeTruthy();
    expect(screen.queryByText('Ann')).toBeNull();
  });

  it('shows the empty text', async () => {
    wrap(<PeoplePanel client={client([])} emptyText="Nobody yet" />);
    expect(await screen.findByText('Nobody yet')).toBeTruthy();
  });
});

describe('InvitesCard', () => {
  const invite: Invite = { matchId: 'm1', from: { user_id: 'ann', displayName: 'Ann' }, createdOn: '2026-10-14T00:00:00.000Z', seatsOpen: 2 };

  it('shows each invite with Join and Dismiss', async () => {
    const c = { getInvites: vi.fn(async () => [invite]), dismissInvite: vi.fn(async () => {}) };
    wrap(<InvitesCard client={c} />);
    expect(await screen.findByText('Ann invited you')).toBeTruthy();
    expect(screen.getByText('2 seats open')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Join' }).getAttribute('href')).toBe('/match/m1');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss invite from Ann' }));
    await waitFor(() => expect(c.dismissInvite).toHaveBeenCalledWith('m1'));
  });

  it('shows nothing without invites', async () => {
    const c = { getInvites: vi.fn(async () => []), dismissInvite: vi.fn() };
    const { container } = wrap(<InvitesCard client={c} />);
    await act(async () => {});
    expect(container.textContent).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (from `apps/web`): `npx vitest run src/people`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`apps/web/src/api/client.ts` — extend the re-export line with `type Invite, type Person`.

`apps/web/src/people/usePeople.ts`:

```ts
// The People list and its search for one client: friends then recent players, swapped for search
// results once two characters are typed (after a pause, so each keystroke isn't a request).
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { apiClient, Person } from '../api/client';

export type PeopleClient = Pick<ReturnType<typeof apiClient>, 'getPeople' | 'searchPeople' | 'addFriend' | 'removeFriend'>;

export const SEARCH_MIN = 2;
const SEARCH_DELAY_MS = 300;

function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function usePeople(client: PeopleClient, query: string) {
  const q = useDebounced(query.trim(), SEARCH_DELAY_MS);
  const searching = q.length >= SEARCH_MIN;
  const queryClient = useQueryClient();
  const people = useQuery({ queryKey: ['people'], queryFn: () => client.getPeople() });
  const search = useQuery({ queryKey: ['people', 'search', q], queryFn: () => client.searchPeople(q), enabled: searching });
  const toggle = useMutation({
    mutationFn: (p: Person) => (p.isFriend ? client.removeFriend(p.user_id) : client.addFriend(p.user_id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['people'] }),
  });
  const shown = searching ? search : people;
  return {
    list: shown.data,
    loading: shown.isLoading,
    error: shown.error,
    searching,
    toggleFriend: (p: Person) => toggle.mutate(p),
  };
}
```

`apps/web/src/people/PeoplePanel.tsx`:

```tsx
// A search box over the People list (usePeople), each person with a star to add or remove them as
// a friend, and an optional action - the Match page's Invite. Used by the Lobby's People tab and
// the Invite players dialog.
import { useState, type JSX, type ReactNode } from 'react';
import { personDetail } from '@fortytwo/client';
import type { Person } from '../api/client';
import { usePeople, type PeopleClient } from './usePeople';
import './People.css';

export function PeoplePanel({
  client,
  hiddenIds = [],
  action,
  emptyText,
}: {
  client: PeopleClient;
  hiddenIds?: string[];
  action?: (person: Person) => ReactNode;
  emptyText: string;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const { list, loading, error, searching, toggleFriend } = usePeople(client, query);
  const shown = (list ?? []).filter((p) => !hiddenIds.includes(p.user_id));

  return (
    <div className="people-panel">
      <input
        type="search"
        className="form-control people-search"
        aria-label="Find a player"
        placeholder="Find a player by name"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {loading && <p className="lobby-note">Loading…</p>}
      {error != null && (
        <p role="alert" className="page-error">
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </p>
      )}
      {!loading && error == null && shown.length === 0 && (
        <p className="lobby-note">{searching ? 'No players by that name.' : emptyText}</p>
      )}
      {shown.length > 0 && (
        <ul className="people-list">
          {shown.map((person) => (
            <li key={person.user_id} className="people-row">
              {person.picture ? (
                <img className="people-avatar" src={person.picture} alt="" />
              ) : (
                <span className="people-avatar people-initial" aria-hidden="true">
                  {person.displayName.trim()[0]?.toUpperCase()}
                </span>
              )}
              <span className="people-text">
                <span className="people-name">{person.displayName}</span>
                <span className="people-detail">{personDetail(person)}</span>
              </span>
              <button
                type="button"
                className={`people-star${person.isFriend ? ' is-friend' : ''}`}
                aria-label={person.isFriend ? `Remove ${person.displayName} from friends` : `Add ${person.displayName} as a friend`}
                aria-pressed={person.isFriend}
                onClick={() => toggleFriend(person)}
              >
                {person.isFriend ? '★' : '☆'}
              </button>
              {action?.(person)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

`apps/web/src/people/InvitesCard.tsx`:

```tsx
// The Lobby's Invited to card: invites to custom tables waiting for the player (GET /api/invites),
// each with Join (the table's seat picker) and Dismiss. Nothing at all when there are none.
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { apiClient } from '../api/client';
import './People.css';

type InvitesClient = Pick<ReturnType<typeof apiClient>, 'getInvites' | 'dismissInvite'>;

export function InvitesCard({ client }: { client: InvitesClient }): JSX.Element | null {
  const queryClient = useQueryClient();
  const invites = useQuery({ queryKey: ['invites'], queryFn: () => client.getInvites() });
  const dismiss = useMutation({
    mutationFn: (matchId: string) => client.dismissInvite(matchId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invites'] }),
  });
  if (!invites.data || invites.data.length === 0) return null;

  return (
    <section className="invites-card mat-panel" aria-label="Invited to">
      <h2 className="invites-title">Invited to</h2>
      <ul className="invites-list">
        {invites.data.map((invite) => (
          <li key={invite.matchId} className="invites-row">
            <span className="people-text">
              <span className="people-name">{invite.from.displayName} invited you</span>
              <span className="people-detail">{invite.seatsOpen === 1 ? '1 seat open' : `${invite.seatsOpen} seats open`}</span>
            </span>
            <Link to={`/match/${invite.matchId}`} className="action-button action-button-small">
              Join
            </Link>
            <button
              type="button"
              className="invites-dismiss"
              aria-label={`Dismiss invite from ${invite.from.displayName}`}
              onClick={() => dismiss.mutate(invite.matchId)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

`apps/web/src/people/People.css` — follow `pages/Lobby.css` for colours and spacing (read it first and reuse its custom properties); minimum rules:

```css
.people-panel { display: flex; flex-direction: column; gap: 0.75rem; }
.people-list, .invites-list { list-style: none; margin: 0; padding: 0; }
.people-row, .invites-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0; }
.people-avatar { width: 2.25rem; height: 2.25rem; border-radius: 50%; object-fit: cover; flex: none; }
.people-initial { display: inline-flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.2); font-weight: 600; }
.people-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.people-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.people-detail { font-size: 0.85em; opacity: 0.75; }
.people-star, .invites-dismiss { background: none; border: none; font-size: 1.25rem; cursor: pointer; color: inherit; }
.people-star.is-friend { color: #d4a63a; }
.invites-card { margin-bottom: 1rem; }
.invites-title { font-size: 1rem; margin: 0 0 0.25rem; }
```

- [ ] **Step 4: Run component tests**

Run: `npx vitest run src/people`
Expected: PASS.

- [ ] **Step 5: Wire into the Lobby**

In `apps/web/src/pages/Lobby.tsx`:

1. Imports: `import { PeoplePanel } from '../people/PeoplePanel';` and `import { InvitesCard } from '../people/InvitesCard';`
2. Replace the tab types:

```ts
type MatchFilter = 'Active' | 'Completed';
type LobbyTab = MatchFilter | 'People';

const TABS: { tab: LobbyTab; label: string }[] = [
  { tab: 'Active', label: 'Active' },
  { tab: 'Completed', label: 'Game History' },
  { tab: 'People', label: 'People' },
];
```

3. State: `const [activeTab, setActiveTab] = useState<LobbyTab>('Active');` and `const matchFilter: MatchFilter = activeTab === 'People' ? 'Active' : activeTab;`. Use `matchFilter` in the `useInfiniteQuery` key/fn and in `refresh`'s `setQueryData` key, and add `enabled: activeTab !== 'People'` to the query. `EMPTY_LABELS[matchFilter]`.
4. Tab buttons map over `TABS` using `tab.tab`. The refresh button: when `activeTab === 'People'`, `onClick` invalidates `['people']` and `['invites']` instead of `refresh()`; otherwise unchanged.
5. Render `<InvitesCard client={client} />` just before the `lobby-tabs` div.
6. Wrap the existing `<section className="lobby-section mat-panel" …>` so it renders only when `activeTab !== 'People'`, and add:

```tsx
      {activeTab === 'People' && (
        <section className="lobby-section mat-panel" aria-label="People">
          <PeoplePanel client={client} emptyText="Play a game and the people you play with show up here." />
        </section>
      )}
```

7. Update the file's top comment: the lobby also has a People tab (friends, recent players, search) and an Invited to card.

In `apps/web/src/pages/Lobby.test.tsx`:
- Add `getPeopleMock`, `searchPeopleMock`, `addFriendMock`, `removeFriendMock`, `getInvitesMock`, `dismissInviteMock` to `vi.hoisted` and to the mocked `apiClient` object; in the existing `beforeEach` give `getInvitesMock.mockResolvedValue([])` and `getPeopleMock.mockResolvedValue([])`.
- Add tests:

```tsx
  it('shows the People tab without fetching matches for it', async () => {
    getPeopleMock.mockResolvedValue([{ user_id: 'bo', displayName: 'Bo', isFriend: false, lastPlayedOn: '2026-01-01T00:00:00.000Z', games: 1 }]);
    renderLobby();
    fireEvent.click(await screen.findByRole('tab', { name: 'People' }));
    expect(await screen.findByText('Bo')).toBeTruthy();
    expect(listMatchesMock).not.toHaveBeenCalledWith('People', expect.anything());
  });

  it('shows invites above the tabs', async () => {
    getInvitesMock.mockResolvedValue([{ matchId: 'm1', from: { user_id: 'ann', displayName: 'Ann' }, createdOn: '2026-01-01T00:00:00.000Z', seatsOpen: 3 }]);
    renderLobby();
    expect(await screen.findByText('Ann invited you')).toBeTruthy();
  });
```

(`renderLobby()` is the file's existing render helper.)

- [ ] **Step 6: Run web tests and typecheck**

Run: `npx vitest run && npx tsc -b`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/people apps/web/src/pages/Lobby.tsx apps/web/src/pages/Lobby.test.tsx
git commit -m "feat(web): People tab and Invited to card in the Lobby"
```

---

### Task 7: Web — Invite players dialog on the Match page

**Files:**
- Create: `apps/web/src/people/InviteDialog.tsx`, `apps/web/src/people/InviteDialog.test.tsx`
- Modify: `apps/web/src/pages/Match.tsx` (~line 849, next to "Invite friends")
- Modify: `apps/web/src/people/People.css`

**Interfaces:**
- Consumes: `PeoplePanel`, `PeopleClient` (Task 6); `invitePlayers` (Task 5); `ApiError` from `../api/client`.
- Produces: `InviteDialog({ open, matchId, seatedIds, client, onClose }: { open: boolean; matchId: string; seatedIds: string[]; client: PeopleClient & Pick<ReturnType<typeof apiClient>, 'invitePlayers'>; onClose: () => void })`

- [ ] **Step 1: Failing test**

`apps/web/src/people/InviteDialog.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Person } from '@fortytwo/client';
import { InviteDialog } from './InviteDialog';

const people: Person[] = [
  { user_id: 'ann', displayName: 'Ann', isFriend: true, lastPlayedOn: null, games: 0 },
  { user_id: 'bo', displayName: 'Bo', isFriend: false, lastPlayedOn: null, games: 0 },
];

function setup(invitePlayers = vi.fn(async (_m: string, ids: string[]) => ({ invited: ids }))) {
  const client = {
    getPeople: vi.fn(async () => people),
    searchPeople: vi.fn(async () => []),
    addFriend: vi.fn(async () => {}),
    removeFriend: vi.fn(async () => {}),
    invitePlayers,
  };
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <InviteDialog open matchId="m1" seatedIds={['bo']} client={client} onClose={onClose} />
    </QueryClientProvider>
  );
  return { client, onClose };
}

afterEach(cleanup);

describe('InviteDialog', () => {
  it('invites a person, hiding anyone already seated', async () => {
    const { client } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Invite Ann' }));
    await waitFor(() => expect(client.invitePlayers).toHaveBeenCalledWith('m1', ['ann']));
    expect(await screen.findByText('Invited ✓')).toBeTruthy();
    expect(screen.queryByText('Bo')).toBeNull();
  });

  it('shows why an invite was refused', async () => {
    setup(vi.fn(async () => { throw new ApiError('Too many invites', 'A table can send at most 6 invites.', 409); }));
    fireEvent.click(await screen.findByRole('button', { name: 'Invite Ann' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Too many invites: A table can send at most 6 invites.');
  });

  it('closes on Escape', async () => {
    const { onClose } = setup();
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/people/InviteDialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `InviteDialog.tsx`**

Modelled on `components/NewMatchDialog.tsx` (scrim, `role="dialog"`, Escape closes, focus on open):

```tsx
// Invite players to a custom table from the Match page: the People list with an Invite button on
// each person not already seated. An invite goes as a push and to their Lobby (POST
// /api/matches/:id/invites); the button then reads Invited ✓.
import { useEffect, useRef, useState, type JSX } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { apiClient } from '../api/client';
import { PeoplePanel } from './PeoplePanel';
import type { PeopleClient } from './usePeople';
import '../components/NewMatchDialog.css';

type InviteClient = PeopleClient & Pick<ReturnType<typeof apiClient>, 'invitePlayers'>;

export function InviteDialog({
  open,
  matchId,
  seatedIds,
  client,
  onClose,
}: {
  open: boolean;
  matchId: string;
  seatedIds: string[];
  client: InviteClient;
  onClose: () => void;
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [invited, setInvited] = useState<string[]>([]);
  const invite = useMutation({
    mutationFn: (userId: string) => client.invitePlayers(matchId, [userId]),
    // Skipped (already invited) counts as invited too: there's nothing more to send.
    onSuccess: (_result, userId) => setInvited((ids) => [...ids, userId]),
  });
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
        aria-labelledby="invite-title"
        tabIndex={-1}
        className="new-match-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2 id="invite-title" className="new-match-title">Invite players</h2>
        {invite.error && (
          <p role="alert" className="new-match-error">
            {invite.error.message}
          </p>
        )}
        <PeoplePanel
          client={client}
          hiddenIds={seatedIds}
          emptyText="Nobody here yet. Search for a player by name, or share the invite link."
          action={(person) =>
            invited.includes(person.user_id) ? (
              <span className="people-invited">Invited ✓</span>
            ) : (
              <button
                type="button"
                className="action-button action-button-small"
                aria-label={`Invite ${person.displayName}`}
                disabled={invite.isPending && invite.variables === person.user_id}
                onClick={() => invite.mutate(person.user_id)}
              >
                Invite
              </button>
            )
          }
        />
      </div>
    </div>
  );
}
```

Add to `People.css`: `.people-invited { font-size: 0.85em; opacity: 0.8; white-space: nowrap; }`

- [ ] **Step 4: Run test**

Run: `npx vitest run src/people/InviteDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Add the button on the Match page**

In `apps/web/src/pages/Match.tsx`: import `InviteDialog`; add `const [inviting, setInviting] = useState(false);` with the other state near the top of the component. Right after the existing "Invite friends" button (inside the same `mode === 'custom' && emptySeats.length > 0` condition — add a second block with the same condition):

```tsx
                    {mode === 'custom' && emptySeats.length > 0 && (
                      <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setInviting(true)}>
                        Invite players
                      </button>
                    )}
```

Render once, near the end of the component's JSX (beside other dialogs):

```tsx
      {match && (
        <InviteDialog
          open={inviting}
          matchId={match.id}
          seatedIds={match.players.map((p) => p.playerId)}
          client={client}
          onClose={() => setInviting(false)}
        />
      )}
```

Use the variable names `Match.tsx` already uses for the match and client (read around line 169 and line 849). Rename the existing "Invite friends" button to **"Share link"** so the two read differently; update any `Match` test that finds it by name (`grep -rn "Invite friends" apps/web/src`).

- [ ] **Step 6: Run web tests and typecheck**

Run: `npx vitest run && npx tsc -b`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/people apps/web/src/pages/Match.tsx
git add -u apps/web/src
git commit -m "feat(web): invite players to a custom table from the Match page"
```

---

### Task 8: Mobile — People segment and Invited to card in the Lobby

**Files:**
- Create: `apps/mobile/src/people/usePeople.ts`, `apps/mobile/src/people/PeoplePanel.tsx`, `apps/mobile/src/people/InvitesCard.tsx`
- Create: `apps/mobile/src/people/__tests__/people.test.tsx`
- Modify: `apps/mobile/src/app/index.tsx`
- Modify: `apps/mobile/src/dev/devBypass.ts` (canned People and invites)

**Interfaces:**
- Consumes: `useApi()` (`@/api/useApi`), client methods (Task 5), `personDetail`, `colors`/`fonts` from `@/components/theme`.
- Produces:
  - `usePeople(query: string): { list: Person[] | undefined; loading: boolean; error: Error | null; searching: boolean; toggleFriend: (p: Person) => void; refresh: () => Promise<void> }`
  - `PeoplePanel({ hiddenIds?, action?, emptyText }: { hiddenIds?: string[]; action?: (p: Person) => ReactNode; emptyText: string })`
  - `InvitesCard()` (no props; reads `useApi()`)

- [ ] **Step 1: Failing tests**

`apps/mobile/src/people/__tests__/people.test.tsx`:

```tsx
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Text } from 'react-native';
import type { Invite, Person } from '@fortytwo/client';
import { PeoplePanel } from '../PeoplePanel';
import { InvitesCard } from '../InvitesCard';

const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockRouter.push(...a) } }));

const ann: Person = { user_id: 'ann', displayName: 'Ann', isFriend: true, lastPlayedOn: null, games: 0 };
const bo: Person = { user_id: 'bo', displayName: 'Bo', isFriend: false, lastPlayedOn: '2026-10-12T00:00:00.000Z', games: 2 };
const invite: Invite = { matchId: 'm1', from: { user_id: 'ann', displayName: 'Ann' }, createdOn: '2026-10-14T00:00:00.000Z', seatsOpen: 1 };

const mockApi = {
  getPeople: jest.fn(async () => [ann, bo]),
  searchPeople: jest.fn(async (q: string) => [ann, bo].filter((p) => p.displayName.toLowerCase().startsWith(q.toLowerCase()))),
  addFriend: jest.fn(async () => {}),
  removeFriend: jest.fn(async () => {}),
  getInvites: jest.fn(async () => [invite]),
  dismissInvite: jest.fn(async () => {}),
};
jest.mock('@/api/useApi', () => ({ useApi: () => mockApi }));

async function show(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => jest.clearAllMocks());

describe('PeoplePanel', () => {
  it('lists people, starring and unstarring', async () => {
    await show(<PeoplePanel emptyText="Nobody yet" />);
    expect(await screen.findByText('Ann')).toBeTruthy();
    expect(screen.getByText(/2 games/)).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Add Bo as a friend'));
    await waitFor(() => expect(mockApi.addFriend).toHaveBeenCalledWith('bo'));
    fireEvent.press(screen.getByLabelText('Remove Ann from friends'));
    await waitFor(() => expect(mockApi.removeFriend).toHaveBeenCalledWith('ann'));
  });

  it('searches once two characters are typed', async () => {
    await show(<PeoplePanel emptyText="Nobody yet" />);
    await screen.findByText('Ann');
    fireEvent.changeText(screen.getByLabelText('Find a player'), 'bo');
    await waitFor(() => expect(mockApi.searchPeople).toHaveBeenCalledWith('bo'));
    await waitFor(() => expect(screen.queryByText('Ann')).toBeNull());
  });

  it('hides people and shows an action for each', async () => {
    await show(<PeoplePanel hiddenIds={['ann']} action={(p) => <Text>Invite {p.displayName}</Text>} emptyText="x" />);
    expect(await screen.findByText('Invite Bo')).toBeTruthy();
    expect(screen.queryByText('Ann')).toBeNull();
  });
});

describe('InvitesCard', () => {
  it('joins and dismisses', async () => {
    await show(<InvitesCard />);
    expect(await screen.findByText('Ann invited you')).toBeTruthy();
    expect(screen.getByText('1 seat open')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Join'));
    expect(mockRouter.push).toHaveBeenCalledWith('/match/m1');
    fireEvent.press(screen.getByLabelText('Dismiss invite from Ann'));
    await waitFor(() => expect(mockApi.dismissInvite).toHaveBeenCalledWith('m1'));
  });

  it('shows nothing without invites', async () => {
    mockApi.getInvites.mockResolvedValueOnce([]);
    await show(<InvitesCard />);
    await act(async () => {});
    expect(screen.queryByText(/invited you/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (from `apps/mobile`): `npx jest src/people`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`apps/mobile/src/people/usePeople.ts`:

```ts
// The People list and its search: friends then recent players, swapped for search results once
// two characters are typed (after a pause, so each keystroke isn't a request).
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Person } from '@fortytwo/client';
import { useApi } from '@/api/useApi';

export const SEARCH_MIN = 2;
const SEARCH_DELAY_MS = 300;

function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function usePeople(query: string) {
  const api = useApi();
  const q = useDebounced(query.trim(), SEARCH_DELAY_MS);
  const searching = q.length >= SEARCH_MIN;
  const queryClient = useQueryClient();
  const people = useQuery({ queryKey: ['people'], queryFn: () => api.getPeople() });
  const search = useQuery({ queryKey: ['people', 'search', q], queryFn: () => api.searchPeople(q), enabled: searching });
  const toggle = useMutation({
    mutationFn: (p: Person) => (p.isFriend ? api.removeFriend(p.user_id) : api.addFriend(p.user_id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['people'] }),
  });
  const shown = searching ? search : people;
  return {
    list: shown.data,
    loading: shown.isLoading,
    error: shown.error,
    searching,
    toggleFriend: (p: Person) => toggle.mutate(p),
    refresh: async () => {
      await queryClient.invalidateQueries({ queryKey: ['people'] });
    },
  };
}
```

`apps/mobile/src/people/PeoplePanel.tsx`:

```tsx
// A search box over the People list (usePeople), each person with a star to add or remove them as
// a friend, and an optional action - the match screen's Invite. Used by the Lobby's People segment
// and the Invite players sheet. Not a FlatList: it sits inside screens that already scroll, and
// the list is capped (30 recent, 20 search results) by the Worker.
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { personDetail, type Person } from '@fortytwo/client';
import { colors, fonts } from '@/components/theme';
import { usePeople } from './usePeople';

export function PeoplePanel({
  hiddenIds = [],
  action,
  emptyText,
}: {
  hiddenIds?: string[];
  action?: (person: Person) => ReactNode;
  emptyText: string;
}) {
  const [query, setQuery] = useState('');
  const { list, loading, error, searching, toggleFriend } = usePeople(query);
  const shown = (list ?? []).filter((p) => !hiddenIds.includes(p.user_id));

  return (
    <View style={styles.panel}>
      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder="Find a player by name"
        placeholderTextColor={colors.inkMuted}
        accessibilityLabel="Find a player"
        autoCorrect={false}
        autoCapitalize="none"
      />
      {loading && <ActivityIndicator color={colors.brass} />}
      {error && <Text style={styles.error}>{error.message}</Text>}
      {!loading && !error && shown.length === 0 && (
        <Text style={styles.empty}>{searching ? 'No players by that name.' : emptyText}</Text>
      )}
      {shown.map((person) => (
        <View key={person.user_id} style={styles.row}>
          {person.picture ? (
            <Image source={{ uri: person.picture }} style={styles.avatar} />
          ) : (
            <View style={styles.avatar}>
              <Text style={styles.initial}>{person.displayName.trim()[0]?.toUpperCase()}</Text>
            </View>
          )}
          <View style={styles.text}>
            <Text style={styles.name} numberOfLines={1}>
              {person.displayName}
            </Text>
            {personDetail(person) !== '' && <Text style={styles.detail}>{personDetail(person)}</Text>}
          </View>
          <Pressable
            onPress={() => toggleFriend(person)}
            accessibilityRole="button"
            accessibilityLabel={person.isFriend ? `Remove ${person.displayName} from friends` : `Add ${person.displayName} as a friend`}
            accessibilityState={{ selected: person.isFriend }}
            hitSlop={8}
          >
            <Text style={[styles.star, person.isFriend && styles.starOn]}>{person.isFriend ? '★' : '☆'}</Text>
          </Pressable>
          {action?.(person)}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 8 },
  search: {
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.walnutDeep,
    color: colors.bone,
    fontFamily: fonts.ui,
    fontSize: 16,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.walnutDeep, alignItems: 'center', justifyContent: 'center' },
  initial: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  text: { flex: 1, minWidth: 0 },
  name: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  detail: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  star: { color: colors.inkMuted, fontSize: 22 },
  starOn: { color: colors.brass },
  empty: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 15, textAlign: 'center', paddingVertical: 24 },
  error: { color: colors.danger, fontFamily: fonts.ui },
});
```

Before writing styles, read `apps/mobile/src/components/theme.ts` and use only colour/font names that exist there (the names used here — `walnut`, `walnutDeep`, `bone`, `inkMuted`, `brass`, `danger`, `ui`, `uiBold`, `display` — exist today).

`apps/mobile/src/people/InvitesCard.tsx`:

```tsx
// The Lobby's Invited to card: invites to custom tables waiting for the player (GET /api/invites),
// each with Join (the table's seat picker) and Dismiss. Nothing at all when there are none.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApi } from '@/api/useApi';
import { colors, fonts } from '@/components/theme';

export function InvitesCard() {
  const api = useApi();
  const queryClient = useQueryClient();
  const invites = useQuery({ queryKey: ['invites'], queryFn: () => api.getInvites() });
  const dismiss = useMutation({
    mutationFn: (matchId: string) => api.dismissInvite(matchId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invites'] }),
  });
  if (!invites.data || invites.data.length === 0) return null;

  return (
    <View style={styles.card} accessibilityLabel="Invited to">
      <Text style={styles.title}>Invited to</Text>
      {invites.data.map((invite) => (
        <View key={invite.matchId} style={styles.row}>
          <View style={styles.text}>
            <Text style={styles.name}>{invite.from.displayName} invited you</Text>
            <Text style={styles.detail}>{invite.seatsOpen === 1 ? '1 seat open' : `${invite.seatsOpen} seats open`}</Text>
          </View>
          <Pressable style={styles.join} onPress={() => router.push(`/match/${invite.matchId}`)} accessibilityRole="button" accessibilityLabel="Join">
            <Text style={styles.joinText}>Join</Text>
          </Pressable>
          <Pressable
            onPress={() => dismiss.mutate(invite.matchId)}
            accessibilityRole="button"
            accessibilityLabel={`Dismiss invite from ${invite.from.displayName}`}
            hitSlop={8}
          >
            <Text style={styles.dismiss}>×</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, padding: 14, gap: 8, backgroundColor: colors.walnutDeep },
  title: { color: colors.brass, fontFamily: fonts.uiBold, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1 },
  name: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  detail: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  join: { borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: colors.brass },
  joinText: { color: colors.walnutDeep, fontFamily: fonts.uiBold },
  dismiss: { color: colors.inkMuted, fontSize: 22 },
});
```



- [ ] **Step 4: Run tests**

Run: `npx jest src/people`
Expected: PASS.

- [ ] **Step 5: Wire into the Lobby (`app/index.tsx`)**

1. Imports: `PeoplePanel` from `@/people/PeoplePanel`, `InvitesCard` from `@/people/InvitesCard`, `ScrollView` from `react-native`.
2. Types:

```ts
type Filter = 'Active' | 'Completed';
type Segment = Filter | 'People';
const SEGMENTS: { segment: Segment; label: string }[] = [
  { segment: 'Active', label: 'Active' },
  { segment: 'Completed', label: 'History' },
  { segment: 'People', label: 'People' },
];
```

3. `const [segment, setSegment] = useState<Segment>('Active');` and `const filter: Filter = segment === 'People' ? 'Active' : segment;` — the rest of the matches code keeps using `filter`; add `enabled: segment !== 'People'` to `useInfiniteQuery`.
4. Segmented control maps `SEGMENTS`, selected = `s === segment`, `onPress={() => setSegment(s)}`.
5. In the header, before the segmented control: `<InvitesCard />`.
6. Replace the body's `matches.isPending ? … : <FlatList …/>` with:

```tsx
      {segment === 'People' ? (
        <ScrollView contentContainerStyle={[styles.list, styles.people, { paddingBottom: FAB_CLEARANCE + insets.bottom }]} keyboardShouldPersistTaps="handled">
          <PeoplePanel emptyText="Play a game and the people you play with show up here." />
        </ScrollView>
      ) : matches.isPending ? (
        /* …existing spinner… */
      ) : (
        /* …existing FlatList… */
      )}
```

and add `people: { paddingHorizontal: 20, paddingTop: 8 }` to `styles`.
7. Refreshing the matches list (`refresh`) also invalidates `['invites']` so a pull-to-refresh picks up new invites.
8. Update the top comment: three segments (Active, History, People) and the Invited to card.

- [ ] **Step 6: Dev bypass answers**

In `apps/mobile/src/dev/devBypass.ts`, add to `handled` (import `Invite, Person` types from `@fortytwo/client`):

```ts
  getPeople: () =>
    answer<Person[]>([
      { user_id: 'gj', displayName: 'Grandma Jo', isFriend: true, lastPlayedOn: new Date(Date.now() - 2 * 86_400_000).toISOString(), games: 9 },
      { user_id: 'sam', displayName: 'Sam', isFriend: false, lastPlayedOn: new Date(Date.now() - 3 * 3_600_000).toISOString(), games: 1 },
    ]),
  searchPeople: () => answer<Person[]>([]),
  addFriend: () => answer(undefined),
  removeFriend: () => answer(undefined),
  getInvites: () =>
    answer<Invite[]>([{ matchId: 'dev-new', from: { user_id: 'gj', displayName: 'Grandma Jo' }, createdOn: new Date().toISOString(), seatsOpen: 2 }]),
  dismissInvite: () => answer(undefined),
  invitePlayers: (_matchId, userIds) => answer({ invited: userIds }),
```

- [ ] **Step 7: Mobile tests and typecheck**

Run: `npx jest && npx tsc --noEmit`
Expected: PASS, clean. (Don't run `expo lint`.)

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/people apps/mobile/src/app/index.tsx apps/mobile/src/dev/devBypass.ts
git commit -m "feat(mobile): People segment and Invited to card in the Lobby"
```

---

### Task 9: Mobile — Invite players sheet on the match screen

**Files:**
- Create: `apps/mobile/src/people/InviteSheet.tsx`
- Modify: `apps/mobile/src/people/__tests__/people.test.tsx`
- Modify: `apps/mobile/src/app/match/[id].tsx` (~line 687)
- Modify: `apps/mobile/src/match/__tests__/matchScreen.test.tsx` only if a test finds "Invite friends" by text

**Interfaces:**
- Consumes: `PeoplePanel` (Task 8), `useApi().invitePlayers` (Task 5), `toastError` from `@/components/toast`.
- Produces: `InviteSheet({ visible, matchId, seatedIds, onClose }: { visible: boolean; matchId: string; seatedIds: string[]; onClose: () => void })`

- [ ] **Step 1: Failing test**

Append to `apps/mobile/src/people/__tests__/people.test.tsx` (add `invitePlayers: jest.fn(async (_m: string, ids: string[]) => ({ invited: ids }))` to `mockApi`; import `InviteSheet` from `../InviteSheet` and `SafeAreaProvider` from `react-native-safe-area-context`; mock toast: `jest.mock('@/components/toast', () => ({ toastError: jest.fn() }));`):

```tsx
describe('InviteSheet', () => {
  const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

  it('invites a person not already seated', async () => {
    await show(
      <SafeAreaProvider initialMetrics={metrics}>
        <InviteSheet visible matchId="m1" seatedIds={['bo']} onClose={jest.fn()} />
      </SafeAreaProvider>
    );
    fireEvent.press(await screen.findByLabelText('Invite Ann'));
    await waitFor(() => expect(mockApi.invitePlayers).toHaveBeenCalledWith('m1', ['ann']));
    expect(await screen.findByText('Invited ✓')).toBeTruthy();
    expect(screen.queryByText('Bo')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/people`
Expected: FAIL — `../InviteSheet` not found.

- [ ] **Step 3: Implement `InviteSheet.tsx`**

Read `apps/mobile/src/components/NewMatchSheet.tsx` and follow its `Modal` + scrim + sheet layout (animation optional — a plain `Modal animationType="slide" transparent` is enough):

```tsx
// Invite players to a custom table from the match screen, as a bottom sheet: the People list with
// an Invite button on each person not already seated. An invite goes as a push and to their
// Lobby (POST /api/matches/:id/invites); the button then reads Invited ✓.
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApi } from '@/api/useApi';
import { colors, fonts } from '@/components/theme';
import { toastError } from '@/components/toast';
import { PeoplePanel } from './PeoplePanel';

export function InviteSheet({
  visible,
  matchId,
  seatedIds,
  onClose,
}: {
  visible: boolean;
  matchId: string;
  seatedIds: string[];
  onClose: () => void;
}) {
  const api = useApi();
  const insets = useSafeAreaInsets();
  const [invited, setInvited] = useState<string[]>([]);
  const invite = useMutation({
    mutationFn: (userId: string) => api.invitePlayers(matchId, [userId]),
    onSuccess: (_result, userId) => setInvited((ids) => [...ids, userId]),
    onError: toastError,
  });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}>
        <Text style={styles.title} accessibilityRole="header">
          Invite players
        </Text>
        <ScrollView keyboardShouldPersistTaps="handled">
          <PeoplePanel
            hiddenIds={seatedIds}
            emptyText="Nobody here yet. Search for a player by name, or share the invite link."
            action={(person) =>
              invited.includes(person.user_id) ? (
                <Text style={styles.invited}>Invited ✓</Text>
              ) : (
                <Pressable
                  style={styles.inviteButton}
                  onPress={() => invite.mutate(person.user_id)}
                  disabled={invite.isPending && invite.variables === person.user_id}
                  accessibilityRole="button"
                  accessibilityLabel={`Invite ${person.displayName}`}
                >
                  <Text style={styles.inviteText}>Invite</Text>
                </Pressable>
              )
            }
          />
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)' },
  sheet: { maxHeight: '80%', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, gap: 12, backgroundColor: colors.walnut },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 22 },
  invited: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  inviteButton: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: colors.brass },
  inviteText: { color: colors.walnutDeep, fontFamily: fonts.uiBold },
});
```

(`toastError(error: unknown)` takes the error as is.)

- [ ] **Step 4: Run test**

Run: `npx jest src/people`
Expected: PASS.

- [ ] **Step 5: Add the button on the match screen**

In `apps/mobile/src/app/match/[id].tsx`: import `InviteSheet` from `@/people/InviteSheet`; add `const [inviting, setInviting] = useState(false);` with the other state. In the `waitingButtons` view, rename the existing button's text to **"Share link"** and add after it:

```tsx
                  {mode === 'custom' && emptySeatCount > 0 && (
                    <Pressable style={styles.smallButton} onPress={() => setInviting(true)} accessibilityRole="button">
                      <Text style={styles.smallButtonText}>Invite players</Text>
                    </Pressable>
                  )}
```

Render the sheet once, next to the screen's other modals:

```tsx
      {match && (
        <InviteSheet
          visible={inviting}
          matchId={match.id}
          seatedIds={match.players.map((p) => p.playerId)}
          onClose={() => setInviting(false)}
        />
      )}
```

Use the names `[id].tsx` already uses for the match. `grep -rn "Invite friends" apps/mobile/src` and update any test that looks for it.

- [ ] **Step 6: Mobile tests and typecheck**

Run: `npx jest && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 7: See it on the emulator**

Use the `mobile-emulator` skill (dev bypass): screenshot the Lobby's People segment with the Invited to card, and a custom match screen with the Invite players sheet open. Fix anything that looks off (theme colours, spacing).

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/people "apps/mobile/src/app/match/[id].tsx"
git add -u apps/mobile/src
git commit -m "feat(mobile): invite players to a custom table from the match screen"
```

---

### Task 10: Whole-repo check

- [ ] **Step 1: Run everything**

From `cloudflare/`: `npm test --workspaces --if-present` and `npm run typecheck --workspaces --if-present`
Expected: all pass, clean.

- [ ] **Step 2: Try the web app against a local worker**

Apply migrations locally (`npx wrangler d1 migrations apply fortytwo --local` in `apps/worker`), run the worker and web dev servers, sign in as two accounts in two browsers: play a custom game to the first deal, check each sees the other under People, star one, invite from a new table, and check the Invited to card's Join opens the seat picker and the card goes once seated.

- [ ] **Step 3: Commit any fixes**, then hand off to `superpowers:finishing-a-development-branch`. The PR title: `feat: recent players, friends and invites (#116)`; body says "Closes #116" and mentions that the migration backfills from current lobby rows only.
