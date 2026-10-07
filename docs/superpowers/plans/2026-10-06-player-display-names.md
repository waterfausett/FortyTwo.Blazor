# Player Display Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match screens never show a raw player id, and player names are served from a D1 `users` table instead of an Auth0 call per lookup.

**Architecture:** The Worker gets a `users` table and one module (`users/publicUsers.ts`) that resolves ids to `PublicUser`s: bots by rule, everyone else from D1, Auth0 only for ids D1 hasn't seen (then saved). Profile fetch and profile save keep the table current. On the client, pure name-state logic lives in `@fortytwo/client` (`playerNames.ts`); each app has a thin `usePlayerNames` react-query hook that caches names per player and only looks up newcomers, and the match screens render a skeleton while a name loads and "Player N" when it can't be found.

**Tech Stack:** Cloudflare Workers + D1 + Hono (`cloudflare/apps/worker`, vitest-pool-workers), TypeScript packages (`cloudflare/packages/*`, vitest), React + react-query + vitest/testing-library (`cloudflare/apps/web`), Expo React Native + react-query + jest (`cloudflare/apps/mobile`).

**Spec:** `docs/superpowers/specs/2026-10-06-player-display-names-design.md`

## Global Constraints

- All paths below are relative to `cloudflare/` unless they start with `docs/`.
- Worker tests: run under Node 25 — in Bash, from `cloudflare/apps/worker`: `export PATH="$APPDATA/nvm/v25.7.0:$PATH"; node ../../node_modules/vitest/vitest.mjs run`. A fresh worktree needs `npm ci` in `cloudflare/` first.
- Package/web tests: `npx vitest run <file>` from the package directory. Mobile tests: `npx jest <file>` from `cloudflare/apps/mobile`.
- A raw player id (`auth0|…`, `p2`, `bot-1`) must never be the text shown for another player on a match screen.
- Failed name: `Player N`, N = seat position + 1. A player not seated: `A player`.
- Bots: `bot-1` -> `Bot 1`, from the server.
- The viewer is always `You`.
- Names do NOT travel with the match: no change to `MatchState`, `matchViewFor` or the MatchDO broadcast.
- `@fortytwo/client` must not import React or react-query.
- D1 writes only when something changed (as `saveToken` does).
- Comments match the surrounding code's style: full sentences explaining why.
- Commit after each task; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The user's own id in the lookup** — the viewer is 'You' and must not be looked up or wait on a lookup; `ready` must not be held back by the viewer. Pinned in Task 4 (`excludes the viewer`).
2. **Lookup fails after names were loaded** (e.g. a join's lookup errors) — names already shown must stay, only the newcomer becomes "Player N". Pinned in Task 4 (`keeps known names when a later lookup fails`).
3. **Every seated player already looked up** (reopening a match, or the cache from the lobby join) — names show on the first render with no skeleton and no request. Pinned in Task 4 (`names everyone at once`).
4. **Auth0 returns only some of the missing ids** — the found ones are saved and returned, the rest left out (client shows "Player N"), no 500. Pinned in Task 2 (`leaves out ids Auth0 doesn't know`).
5. **Saving to D1 fails on profile fetch / save** — the profile request still succeeds; the cache is best-effort. Pinned in Task 3 (`still returns the profile when saving the name fails`).

---

### Task 1: Bot display names (rules)

**Files:**
- Modify: `packages/rules/src/botIds.ts`
- Modify: `packages/rules/src/index.ts:62`
- Create: `packages/rules/src/botIds.test.ts`

**Interfaces:**
- Produces: `botDisplayName(playerId: string): string` exported from `@fortytwo/rules`.

- [ ] **Step 1: Write the failing test** — `packages/rules/src/botIds.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BOT_IDS, botDisplayName } from './botIds';

describe('botDisplayName', () => {
  it('names each bot by its number', () => {
    expect(BOT_IDS.map(botDisplayName)).toEqual(['Bot 1', 'Bot 2', 'Bot 3']);
  });
});
```

- [ ] **Step 2: Run it to see it fail** — from `packages/rules`: `npx vitest run src/botIds.test.ts`. Expected: FAIL, `botDisplayName` is not exported.

- [ ] **Step 3: Implement** — append to `packages/rules/src/botIds.ts`:

```ts
// What a bot is called at the table: bot-1 is "Bot 1". Bots have no account to take a name from.
export function botDisplayName(playerId: string): string {
  return `Bot ${playerId.slice('bot-'.length)}`;
}
```

and change `packages/rules/src/index.ts:62` to:

```ts
export { BOT_IDS, botDisplayName, isBot } from './botIds';
```

- [ ] **Step 4: Run it to see it pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rules/src/botIds.ts packages/rules/src/botIds.test.ts packages/rules/src/index.ts
git commit -m "Rules: botDisplayName names bots \"Bot 1\".. (#72)"
```

---

### Task 2: `users` table and `publicUsers` (Worker)

**Files:**
- Create: `apps/worker/migrations/0007_users.sql`
- Create: `apps/worker/src/users/profile.ts` (moved `toUserResponse`/`toPublicUser`)
- Create: `apps/worker/src/users/publicUsers.ts`
- Modify: `apps/worker/src/routes/users.ts` (re-export the moved functions)
- Create: `apps/worker/test/publicUsers.test.ts`

**Interfaces:**
- Consumes: `botDisplayName`, `isBot` from `@fortytwo/rules`; `getUsers`, `MAX_USER_IDS`, `Auth0User` from `../auth0Management`.
- Produces:
  - `saveUsers(db: D1Database, users: PublicUser[], now?: Date): Promise<void>`
  - `rememberUser(db: D1Database, user: Auth0User): Promise<void>` — best-effort save, never throws.
  - `publicUsers(env: Env, ids: string[]): Promise<PublicUser[]>`
  - `toUserResponse`, `toPublicUser` now live in `src/users/profile.ts`, still exported from `src/routes/users.ts`.

- [ ] **Step 1: Add the migration** — `apps/worker/migrations/0007_users.sql`:

```sql
-- What other players see of each player (PublicUser): their display name and picture, kept here so
-- the lobby and the match screens' name lookups don't each cost an Auth0 Management API call. Auth0
-- stays the source of truth; users/publicUsers.ts fills a row on first lookup and refreshes it when
-- the player fetches or saves their profile. Deleting an account must delete its row.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  picture TEXT,
  updated_on TEXT NOT NULL
);
```

- [ ] **Step 2: Move `toUserResponse`/`toPublicUser`** — cut both functions (and their comments) from `apps/worker/src/routes/users.ts` into a new `apps/worker/src/users/profile.ts`:

```ts
// How an Auth0 user is shown: to themselves (toUserResponse) and to other players (toPublicUser).
import type { Auth0User } from '../auth0Management';
import type { PublicUser, UserProfile } from '@fortytwo/api-types';

// …the two functions exactly as they were in routes/users.ts…
```

In `routes/users.ts` replace them with:

```ts
import { toPublicUser, toUserResponse } from '../users/profile';
export { toPublicUser, toUserResponse };
```

(This keeps `test/routes.users.test.ts`'s imports working and avoids an import cycle between `routes/users.ts` and `users/publicUsers.ts`.) Remove now-unused imports (`UserProfile`) from `routes/users.ts`.

- [ ] **Step 3: Write the failing tests** — `apps/worker/test/publicUsers.test.ts`:

```ts
// users/publicUsers.ts against the test D1 (migrations applied by applyMigrations.ts). The Auth0
// paths are covered through the routes in routes.users.test.ts.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index';
import { publicUsers, saveUsers } from '../src/users/publicUsers';

const testEnv = env as unknown as Env;

async function row(id: string) {
  return testEnv.DB.prepare('SELECT display_name, picture, updated_on FROM users WHERE id = ?1')
    .bind(id)
    .first<{ display_name: string; picture: string | null; updated_on: string }>();
}

describe('saveUsers', () => {
  it('stores a player, and rewrites the row only when their name or picture changed', async () => {
    const first = new Date('2026-10-01T00:00:00.000Z');
    const later = new Date('2026-10-02T00:00:00.000Z');
    await saveUsers(testEnv.DB, [{ user_id: 'auth0|a', displayName: 'Amy', picture: 'a.png' }], first);
    expect(await row('auth0|a')).toEqual({ display_name: 'Amy', picture: 'a.png', updated_on: first.toISOString() });

    await saveUsers(testEnv.DB, [{ user_id: 'auth0|a', displayName: 'Amy', picture: 'a.png' }], later);
    expect((await row('auth0|a'))?.updated_on).toBe(first.toISOString());

    await saveUsers(testEnv.DB, [{ user_id: 'auth0|a', displayName: 'Amelia', picture: 'a.png' }], later);
    expect(await row('auth0|a')).toEqual({ display_name: 'Amelia', picture: 'a.png', updated_on: later.toISOString() });

    await saveUsers(testEnv.DB, [{ user_id: 'auth0|a', displayName: 'Amelia' }], first);
    expect(await row('auth0|a')).toEqual({ display_name: 'Amelia', picture: null, updated_on: first.toISOString() });
  });
});

describe('publicUsers', () => {
  it('reads stored players from D1 and names bots, without asking Auth0', async () => {
    // fetchMock isn't active in this file, so an Auth0 call would fail and leave auth0|b out.
    await saveUsers(testEnv.DB, [{ user_id: 'auth0|b', displayName: 'Bea', picture: 'b.png' }]);
    const found = await publicUsers(testEnv, ['auth0|b', 'bot-2', 'auth0|b']);
    expect(found).toEqual(
      expect.arrayContaining([
        { user_id: 'auth0|b', displayName: 'Bea', picture: 'b.png' },
        { user_id: 'bot-2', displayName: 'Bot 2' },
      ])
    );
    expect(found).toHaveLength(2);
  });

  it('returns what it has when Auth0 cannot be reached', async () => {
    await saveUsers(testEnv.DB, [{ user_id: 'auth0|c', displayName: 'Cy' }]);
    expect(await publicUsers(testEnv, ['auth0|c', 'auth0|nobody'])).toEqual([{ user_id: 'auth0|c', displayName: 'Cy' }]);
  });
});
```

- [ ] **Step 4: Run them to see them fail** — worker test command (Global Constraints) with `test/publicUsers.test.ts` appended. Expected: FAIL, module `../src/users/publicUsers` not found.

- [ ] **Step 5: Implement** — `apps/worker/src/users/publicUsers.ts`:

```ts
// The users table (migrations/0007_users.sql): what any player may see of another, kept in D1 so
// name lookups (POST /api/users/search, the lobby list) don't each cost an Auth0 Management API
// call - its rate limits are what would hurt first as play grows. Auth0 is only asked about players
// D1 hasn't seen, and what it returns is kept for next time.
import type { PublicUser } from '@fortytwo/api-types';
import { botDisplayName, isBot } from '@fortytwo/rules';
import type { Env } from '../index';
import { getUsers, MAX_USER_IDS, type Auth0User } from '../auth0Management';
import { toPublicUser } from './profile';

// Saves each player's name and picture. A row that already says the same is left alone - D1 bills
// every row written, and the apps fetch the profile on every launch.
export async function saveUsers(db: D1Database, users: PublicUser[], now: Date = new Date()): Promise<void> {
  if (users.length === 0) return;
  await db.batch(
    users.map((user) =>
      db
        .prepare(
          `INSERT INTO users (id, display_name, picture, updated_on) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (id) DO UPDATE SET display_name = ?2, picture = ?3, updated_on = ?4
           WHERE display_name IS NOT ?2 OR picture IS NOT ?3`
        )
        .bind(user.user_id, user.displayName, user.picture ?? null, now.toISOString())
    )
  );
}

// Keeps D1 in step with a player's own profile, fetched or just saved. Best-effort: the table is a
// cache, so failing to write it mustn't fail the request that carried the profile.
export async function rememberUser(db: D1Database, user: Auth0User): Promise<void> {
  try {
    await saveUsers(db, [toPublicUser(user)]);
  } catch (error) {
    console.error('Failed to save player name', error);
  }
}

async function storedUsers(db: D1Database, ids: string[]): Promise<PublicUser[]> {
  const found: PublicUser[] = [];
  for (let i = 0; i < ids.length; i += MAX_USER_IDS) {
    const chunk = ids.slice(i, i + MAX_USER_IDS);
    const placeholders = chunk.map((_, j) => `?${j + 1}`).join(', ');
    const { results } = await db
      .prepare(`SELECT id, display_name, picture FROM users WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ id: string; display_name: string; picture: string | null }>();
    for (const row of results) {
      found.push({ user_id: row.id, displayName: row.display_name, ...(row.picture != null && { picture: row.picture }) });
    }
  }
  return found;
}

// What each id is shown as: bots by number, everyone else from D1, and from Auth0 (then saved) for
// anyone D1 hasn't seen. Ids that can't be resolved - unknown to Auth0, or Auth0 unreachable - are
// left out, and the client shows them as "Player N".
export async function publicUsers(env: Env, ids: string[]): Promise<PublicUser[]> {
  const unique = [...new Set(ids)];
  const bots = unique.filter(isBot).map((id): PublicUser => ({ user_id: id, displayName: botDisplayName(id) }));
  const humans = unique.filter((id) => !isBot(id));
  const stored = await storedUsers(env.DB, humans);
  const known = new Set(stored.map((user) => user.user_id));
  const missing = humans.filter((id) => !known.has(id));

  const fetched: PublicUser[] = [];
  try {
    for (let i = 0; i < missing.length; i += MAX_USER_IDS) {
      const users = await getUsers(env, missing.slice(i, i + MAX_USER_IDS));
      fetched.push(...users.map(toPublicUser));
    }
  } catch (error) {
    console.error('Failed to look players up in Auth0', error);
  }
  try {
    await saveUsers(env.DB, fetched);
  } catch (error) {
    console.error('Failed to save player names', error);
  }
  return [...bots, ...stored, ...fetched];
}
```

- [ ] **Step 6: Run them to see them pass** — same command. Expected: PASS. Then run the whole worker suite once (Global Constraints command) to confirm the move in Step 2 broke nothing. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/migrations/0007_users.sql apps/worker/src/users apps/worker/src/routes/users.ts apps/worker/test/publicUsers.test.ts
git commit -m "Worker: users table caching player names, with publicUsers lookup (#72)"
```

---

### Task 3: Routes read and refresh the `users` table (Worker)

**Files:**
- Modify: `apps/worker/src/auth0Management.ts:147-153` (`updateUser` returns the user)
- Modify: `apps/worker/src/routes/users.ts` (profile, search, patch)
- Modify: `apps/worker/src/routes/matches.ts:84-99` (`displayNames`)
- Modify: `apps/worker/test/routes.users.test.ts`

**Interfaces:**
- Consumes: `publicUsers`, `rememberUser` (Task 2).
- Produces: `updateUser(env, userId, patch): Promise<Auth0User>`.

- [ ] **Step 1: Write the failing tests** — in `apps/worker/test/routes.users.test.ts`:

Add `import { saveUsers } from '../src/users/publicUsers';` and these helpers after `mockUserPatch`:

```ts
// Answers the next Auth0 single-user fetch with `user`.
function mockGetUser(user: Auth0User): void {
  fetchMock
    .get(`https://${AUTH0_DOMAIN}`)
    .intercept({ path: `/api/v2/users/${encodeURIComponent(user.user_id)}`, method: 'GET' })
    .reply(200, JSON.stringify(user), { headers: { 'content-type': 'application/json' } });
}

async function storedName(id: string): Promise<{ display_name: string; picture: string | null } | null> {
  return env.DB.prepare('SELECT display_name, picture FROM users WHERE id = ?1')
    .bind(id)
    .first<{ display_name: string; picture: string | null }>();
}
```

Change `mockUserPatch`'s reply so it answers like Auth0 (the updated user):

```ts
    .reply((opts) => {
      seen.path = String(opts.path);
      seen.body = JSON.parse(String(opts.body));
      const userId = decodeURIComponent(seen.path.slice('/api/v2/users/'.length));
      const user = { user_id: userId, picture: 'https://example.com/auth0.png', ...(seen.body as object) };
      return { statusCode: 200, data: JSON.stringify(user), responseOptions: { headers: { 'content-type': 'application/json' } } };
    });
```

Replace the `'looks each id up once'` test with:

```ts
    it('asks Auth0 once per unknown player, never for bots', async () => {
      const seen = mockUserSearch([]);
      const res = await api('/api/users/search', 'auth0|p1', {
        method: 'POST',
        body: JSON.stringify(['auth0|p2', 'bot-1', 'auth0|p2']),
      });
      expect(seen.query).toBe('user_id:("auth0|p2")');
      expect(await res.json()).toEqual([{ user_id: 'bot-1', displayName: 'Bot 1' }]);
    });

    it('answers from D1 for players it has seen, without asking Auth0', async () => {
      await saveUsers(env.DB, [{ user_id: 'auth0|p2', displayName: 'Stored Two' }]);
      // No search mock: with net connect disabled, an Auth0 call would fail and leave p2 out.
      const res = await api('/api/users/search', 'auth0|p1', { method: 'POST', body: JSON.stringify(['auth0|p2']) });
      expect(await res.json()).toEqual([{ user_id: 'auth0|p2', displayName: 'Stored Two' }]);
    });

    it('keeps what Auth0 finds for next time', async () => {
      mockUserSearch([{ user_id: 'auth0|p2', nickname: 'two', picture: 'https://example.com/p2.png' }]);
      await api('/api/users/search', 'auth0|p1', { method: 'POST', body: JSON.stringify(['auth0|p2']) });
      expect(await storedName('auth0|p2')).toEqual({ display_name: 'two', picture: 'https://example.com/p2.png' });
    });

    it("leaves out ids Auth0 doesn't know", async () => {
      mockUserSearch([{ user_id: 'auth0|p2', nickname: 'two' }]);
      const res = await api('/api/users/search', 'auth0|p1', {
        method: 'POST',
        body: JSON.stringify(['auth0|p2', 'auth0|gone']),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([{ user_id: 'auth0|p2', displayName: 'two' }]);
    });

    it('answers with what D1 has when Auth0 fails', async () => {
      await saveUsers(env.DB, [{ user_id: 'auth0|p2', displayName: 'Stored Two' }]);
      fetchMock
        .get(`https://${AUTH0_DOMAIN}`)
        .intercept({ path: (path: string) => path.startsWith('/api/v2/users?'), method: 'GET' })
        .reply(500, 'down');
      const res = await api('/api/users/search', 'auth0|p1', {
        method: 'POST',
        body: JSON.stringify(['auth0|p2', 'auth0|p3']),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([{ user_id: 'auth0|p2', displayName: 'Stored Two' }]);
    });
```

Add a `GET /api/users/profile` describe:

```ts
  describe('GET /api/users/profile', () => {
    it("keeps the caller's name and picture in D1", async () => {
      mockGetUser({ user_id: 'auth0|p1', picture: 'https://example.com/p1.png', user_metadata: { displayName: 'One' } });
      const res = await api('/api/users/profile', 'auth0|p1');
      expect(res.status).toBe(200);
      expect(await storedName('auth0|p1')).toEqual({ display_name: 'One', picture: 'https://example.com/p1.png' });
    });

    it('still returns the profile when saving the name fails', async () => {
      await env.DB.exec('ALTER TABLE users RENAME TO users_gone');
      try {
        mockGetUser({ user_id: 'auth0|p1', user_metadata: { displayName: 'One' } });
        const res = await api('/api/users/profile', 'auth0|p1');
        expect(res.status).toBe(200);
        expect(((await res.json()) as { displayName: string }).displayName).toBe('One');
      } finally {
        await env.DB.exec('ALTER TABLE users_gone RENAME TO users');
      }
    });
  });
```

In `describe('PATCH /api/users')` add:

```ts
    it('updates the name other players see', async () => {
      mockUserPatch();
      await api('/api/users', 'auth0|p1', { method: 'PATCH', body: JSON.stringify({ displayName: 'New One' }) });
      expect(await storedName('auth0|p1')).toEqual({ display_name: 'New One', picture: 'https://example.com/auth0.png' });
    });
```

- [ ] **Step 2: Run them to see them fail** — worker test command with `test/routes.users.test.ts`. Expected: the new search/profile/patch tests FAIL (Auth0 queried with bot-1, nothing stored).

- [ ] **Step 3: Implement**

`apps/worker/src/auth0Management.ts` — `updateUser` returns the updated user (comment adds that Auth0 replies with it):

```ts
// Auth0 merges `user_metadata`, so this only changes the fields `patch` sets: JSON.stringify drops
// `undefined` keys (an unset field must be `undefined`, not `null`, or it would be cleared). Auth0
// replies with the user as it now is.
export async function updateUser(env: Env, userId: string, patch: ProfilePatch): Promise<Auth0User> {
  const response = await authorizedFetch(env, `api/v2/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_metadata: patch }),
  });
  return response.json();
}
```

`apps/worker/src/routes/users.ts` — import `publicUsers, rememberUser` from `'../users/publicUsers'`, drop the `getUsers` import, update the header comment to mention D1, and change the three routes:

```ts
// The caller's own full profile - the only route that returns email and name. Fetching it also
// refreshes what other players see of them (users/publicUsers.ts), which is how a name changed
// outside the app reaches the table.
users.get('/profile', async (c) => {
  const user = await getUser(c.env, c.get('user').sub);
  await rememberUser(c.env.DB, user);
  return c.json(toUserResponse(user));
});

users.post('/search', async (c) => {
  return c.json(await publicUsers(c.env, await readUserIds(c)));
});

users.patch('/', async (c) => {
  const user = await updateUser(c.env, c.get('user').sub, profilePatch(await readBody(c)));
  await rememberUser(c.env.DB, user);
  return c.body(null, 200);
});
```

`apps/worker/src/routes/matches.ts` — replace `displayNames` (and its comment) with:

```ts
// Maps player ids to display names for the lobby list (users/publicUsers.ts: D1 first, Auth0 for
// players it hasn't seen, bots by number). Anyone it can't name keeps their id - the list is still
// usable, which beats failing the whole lobby over a cosmetic field.
async function displayNames(env: Env, playerIds: string[]): Promise<Map<string, string>> {
  return new Map((await publicUsers(env, playerIds)).map((user) => [user.user_id, user.displayName]));
}
```

Import `publicUsers` from `'../users/publicUsers'`; remove imports `matches.ts` no longer uses (`getUsers`, `MAX_USER_IDS`, `toUserResponse`, and `isBot` if unused elsewhere in the file — check with `grep -n "isBot\|getUsers\|MAX_USER_IDS\|toUserResponse" apps/worker/src/routes/matches.ts`).

- [ ] **Step 4: Run the whole worker suite** — Global Constraints command. Expected: PASS, including `routes.matches.test.ts`'s lobby name tests unchanged (`[['Player One', 'three'], ['p2']]` and raw `p1`/`p2` when Auth0 is unreachable). Then `npx tsc --noEmit -p apps/worker` from `cloudflare/`. Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src apps/worker/test/routes.users.test.ts
git commit -m "Worker: search and lobby read names from D1; profile fetch and save keep it current (#72)"
```

---

### Task 4: Name state (`@fortytwo/client`) and the web `usePlayerNames` hook

**Files:**
- Create: `packages/client/src/playerNames.ts`
- Create: `packages/client/src/playerNames.test.ts`
- Modify: `packages/client/src/index.ts` (export it)
- Create: `apps/web/src/match/usePlayerNames.ts`
- Create: `apps/web/src/match/usePlayerNames.test.tsx`

**Interfaces:**
- Produces (client):
  - `type PlayerName = { status: 'loaded'; name: string } | { status: 'loading' } | { status: 'failed'; name: string }`
  - `interface NameLookup { myPlayerId: string | null | undefined; players: readonly { playerId: string; position: number }[]; names: ReadonlyMap<string, string> | undefined; settled: boolean; failed: boolean }`
  - `playerName(playerId: string, lookup: NameLookup): PlayerName`
  - `nameText(name: PlayerName): string | null` — null while loading
  - `missingIds(ids: readonly string[], known: ReadonlyMap<string, string>): string[]`
  - `mergeNames(...maps: (ReadonlyMap<string, string> | undefined)[]): Map<string, string>`
- Produces (web): `usePlayerNames(players, myPlayerId, searchUsers): { nameFor: (playerId: string) => PlayerName; ready: boolean }` and `PLAYER_NAMES_KEY = 'playerNames'`.

- [ ] **Step 1: Write the failing client tests** — `packages/client/src/playerNames.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mergeNames, missingIds, nameText, playerName, type NameLookup } from './playerNames';

const players = [
  { playerId: 'p1', position: 0 },
  { playerId: 'p2', position: 1 },
  { playerId: 'p3', position: 2 },
];
const lookup = (over: Partial<NameLookup> = {}): NameLookup => ({
  myPlayerId: 'p1',
  players,
  names: new Map([['p2', 'Bob']]),
  settled: true,
  failed: false,
  ...over,
});

describe('playerName', () => {
  it('calls the viewer You, whatever the lookup says', () => {
    expect(playerName('p1', lookup({ names: undefined, settled: false }))).toEqual({ status: 'loaded', name: 'You' });
  });

  it('uses a looked-up name', () => {
    expect(playerName('p2', lookup())).toEqual({ status: 'loaded', name: 'Bob' });
  });

  it('waits while the lookup for this player is still out', () => {
    expect(playerName('p3', lookup({ settled: false }))).toEqual({ status: 'loading' });
  });

  it('falls back to the seat, never the id, once the lookup came back without them', () => {
    expect(playerName('p3', lookup())).toEqual({ status: 'failed', name: 'Player 3' });
  });

  it('falls back to the seat when the lookup failed', () => {
    expect(playerName('p3', lookup({ settled: false, failed: true }))).toEqual({ status: 'failed', name: 'Player 3' });
  });

  it('keeps a known name even when the latest lookup failed', () => {
    expect(playerName('p2', lookup({ settled: false, failed: true }))).toEqual({ status: 'loaded', name: 'Bob' });
  });

  it('calls someone not seated "A player"', () => {
    expect(playerName('gone', lookup())).toEqual({ status: 'failed', name: 'A player' });
  });
});

describe('nameText', () => {
  it('is the name, the fallback, or null while loading', () => {
    expect(nameText({ status: 'loaded', name: 'Bob' })).toBe('Bob');
    expect(nameText({ status: 'failed', name: 'Player 3' })).toBe('Player 3');
    expect(nameText({ status: 'loading' })).toBeNull();
  });
});

describe('missingIds / mergeNames', () => {
  it('finds the ids not looked up yet', () => {
    expect(missingIds(['p2', 'p3'], new Map([['p2', 'Bob']]))).toEqual(['p3']);
  });

  it('merges lookups, later ones winning, skipping missing ones', () => {
    const merged = mergeNames(new Map([['p2', 'Bob']]), undefined, new Map([['p2', 'Bobby'], ['p3', 'Cy']]));
    expect([...merged]).toEqual([['p2', 'Bobby'], ['p3', 'Cy']]);
  });
});
```

- [ ] **Step 2: Run to see it fail** — from `packages/client`: `npx vitest run src/playerNames.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement** — `packages/client/src/playerNames.ts`:

```ts
// What to call each player at the table while their display names are looked up
// (POST /api/users/search). A raw player id is never shown: while a name is on its way the screen
// shows a placeholder, and a player the lookup couldn't name is called by their seat ("Player 2").
// Each app's usePlayerNames hook does the fetching and caching; this decides what it means.

export type PlayerName =
  | { status: 'loaded'; name: string }
  | { status: 'loading' }
  | { status: 'failed'; name: string };

export interface NameLookup {
  myPlayerId: string | null | undefined;
  players: readonly { playerId: string; position: number }[];
  // Every name known so far - the latest lookup's, or earlier ones' while it's still out.
  names: ReadonlyMap<string, string> | undefined;
  // The lookup for the players seated now has come back. Anyone it left out isn't coming.
  settled: boolean;
  // The lookup for the players seated now failed.
  failed: boolean;
}

export function playerName(playerId: string, lookup: NameLookup): PlayerName {
  if (playerId === lookup.myPlayerId) return { status: 'loaded', name: 'You' };
  const name = lookup.names?.get(playerId);
  if (name != null) return { status: 'loaded', name };
  if (!lookup.settled && !lookup.failed) return { status: 'loading' };
  const seat = lookup.players.find((p) => p.playerId === playerId);
  return { status: 'failed', name: seat ? `Player ${seat.position + 1}` : 'A player' };
}

// The name to put in a sentence, or null while it's still loading.
export function nameText(name: PlayerName): string | null {
  return name.status === 'loading' ? null : name.name;
}

export function missingIds(ids: readonly string[], known: ReadonlyMap<string, string>): string[] {
  return ids.filter((id) => !known.has(id));
}

export function mergeNames(...maps: (ReadonlyMap<string, string> | undefined)[]): Map<string, string> {
  const merged = new Map<string, string>();
  for (const map of maps) for (const [id, name] of map ?? []) merged.set(id, name);
  return merged;
}
```

Add `export * from './playerNames';` to `packages/client/src/index.ts` (alphabetical, after `./optimistic`) and add "player names" to its header comment's list.

- [ ] **Step 4: Run to see it pass** — same command. Expected: PASS.

- [ ] **Step 5: Write the failing hook tests** — `apps/web/src/match/usePlayerNames.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PublicUser } from '@fortytwo/client';
import { usePlayerNames } from './usePlayerNames';

const seated = (...ids: string[]) => ids.map((playerId, position) => ({ playerId, position }));
const echo = (ids: string[]): PublicUser[] => ids.map((id) => ({ user_id: id, displayName: `name-${id}` }));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

describe('usePlayerNames', () => {
  it('excludes the viewer, who is always You', async () => {
    const search = vi.fn(async (ids: string[]) => echo(ids));
    const { wrapper } = setup();
    const { result } = renderHook(() => usePlayerNames(seated('p1', 'p2'), 'p1', search), { wrapper });
    expect(result.current.nameFor('p1')).toEqual({ status: 'loaded', name: 'You' });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(search).toHaveBeenCalledWith(['p2']);
  });

  it('looks up only a newcomer, keeping the names already shown', async () => {
    const search = vi.fn(async (ids: string[]) => echo(ids));
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ ids }) => usePlayerNames(seated(...ids), 'p1', search), {
      wrapper,
      initialProps: { ids: ['p1', 'p2'] },
    });
    await waitFor(() => expect(result.current.nameFor('p2')).toEqual({ status: 'loaded', name: 'name-p2' }));

    rerender({ ids: ['p1', 'p2', 'p3'] });
    expect(result.current.nameFor('p2')).toEqual({ status: 'loaded', name: 'name-p2' });
    expect(result.current.nameFor('p3')).toEqual({ status: 'loading' });
    expect(result.current.ready).toBe(false);

    await waitFor(() => expect(result.current.nameFor('p3')).toEqual({ status: 'loaded', name: 'name-p3' }));
    expect(search).toHaveBeenLastCalledWith(['p3']);
    expect(result.current.ready).toBe(true);
  });

  it('names everyone at once when they were all looked up before', async () => {
    const search = vi.fn(async (ids: string[]) => echo(ids));
    const { wrapper } = setup();
    const first = renderHook(() => usePlayerNames(seated('p1', 'p2', 'p3'), 'p1', search), { wrapper });
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    first.unmount();

    const { result } = renderHook(() => usePlayerNames(seated('p1', 'p3', 'p2'), 'p1', search), { wrapper });
    expect(result.current.ready).toBe(true);
    expect(result.current.nameFor('p3')).toEqual({ status: 'loaded', name: 'name-p3' });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('calls a player the lookup did not find by their seat', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => usePlayerNames(seated('p1', 'p2'), 'p1', async () => []), { wrapper });
    await waitFor(() => expect(result.current.nameFor('p2')).toEqual({ status: 'failed', name: 'Player 2' }));
    expect(result.current.ready).toBe(true);
  });

  it('keeps known names when a later lookup fails', async () => {
    const search = vi.fn(async (ids: string[]) => echo(ids));
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ ids }) => usePlayerNames(seated(...ids), 'p1', search), {
      wrapper,
      initialProps: { ids: ['p1', 'p2'] },
    });
    await waitFor(() => expect(result.current.ready).toBe(true));

    search.mockRejectedValueOnce(new Error('down'));
    rerender({ ids: ['p1', 'p2', 'p3'] });
    await waitFor(() => expect(result.current.nameFor('p3')).toEqual({ status: 'failed', name: 'Player 3' }));
    expect(result.current.nameFor('p2')).toEqual({ status: 'loaded', name: 'name-p2' });
  });
});
```

- [ ] **Step 6: Run to see it fail** — from `apps/web`: `npx vitest run src/match/usePlayerNames.test.tsx`. Expected: FAIL, module not found.

- [ ] **Step 7: Implement** — `apps/web/src/match/usePlayerNames.ts`:

```ts
// Display names for the players at a match (@fortytwo/client's playerNames.ts says what to call
// each one). Names are cached per player across lookups: a join only looks up the newcomer, the
// names already shown stay up meanwhile, and a match whose players were all looked up before is
// named on its first render. The viewer is never looked up - they're always "You".
import { useMemo } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { mergeNames, missingIds, playerName, type PlayerName, type PublicUser } from '@fortytwo/client';

export const PLAYER_NAMES_KEY = 'playerNames';

export function usePlayerNames(
  players: readonly { playerId: string; position: number }[],
  myPlayerId: string | undefined,
  searchUsers: (ids: string[]) => Promise<PublicUser[]>
): { nameFor: (playerId: string) => PlayerName; ready: boolean } {
  const queryClient = useQueryClient();
  const ids = players.map((p) => p.playerId).filter((id) => id !== myPlayerId).sort();
  // Every name any earlier lookup found.
  const known = () =>
    mergeNames(...queryClient.getQueriesData<Map<string, string>>({ queryKey: [PLAYER_NAMES_KEY] }).map(([, data]) => data));

  const query = useQuery({
    queryKey: [PLAYER_NAMES_KEY, ids],
    queryFn: async () => {
      const names = known();
      const missing = missingIds(ids, names);
      if (missing.length > 0) for (const user of await searchUsers(missing)) names.set(user.user_id, user.displayName);
      return names;
    },
    initialData: () => {
      const names = known();
      return missingIds(ids, names).length === 0 ? names : undefined;
    },
    placeholderData: keepPreviousData,
    enabled: ids.length > 0,
    staleTime: Infinity,
  });

  // A failed lookup has no data of its own; the names found before it still stand.
  const names = query.data ?? known();
  const settled = query.isSuccess && !query.isPlaceholderData;
  const failed = query.isError;
  const seatsKey = players.map((p) => `${p.playerId}@${p.position}`).join();
  return useMemo(() => {
    const nameFor = (playerId: string) => playerName(playerId, { myPlayerId, players, names, settled, failed });
    return { nameFor, ready: ids.every((id) => nameFor(id).status !== 'loading') };
    // `players` and `ids` change identity every render; seatsKey stands for both.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatsKey, myPlayerId, query.data, settled, failed]);
}
```

(If `oxlint` doesn't know the `eslint-disable` rule name, drop that line — `npm run lint` in `apps/web` decides.)

- [ ] **Step 8: Run to see it pass** — same command. Expected: PASS (5 tests).

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/playerNames.ts packages/client/src/playerNames.test.ts packages/client/src/index.ts apps/web/src/match/usePlayerNames.ts apps/web/src/match/usePlayerNames.test.tsx
git commit -m "Client: player name state, and a web hook that only looks up newcomers (#72)"
```

---

### Task 5: Web match screen shows skeletons and "Player N", never ids

**Files:**
- Create: `apps/web/src/components/NameSkeleton.tsx`, `apps/web/src/components/NameSkeleton.css`
- Modify: `apps/web/src/components/Seat.tsx` (`name: string | null`)
- Modify: `apps/web/src/components/SeatPicker.tsx` (`loading` prop)
- Modify: `apps/web/src/match/usePoke.ts` (`nameOf` may return null)
- Modify: `apps/web/src/pages/Match.tsx`
- Modify: `apps/web/src/pages/Match.test.tsx`

**Interfaces:**
- Consumes: `usePlayerNames`, `PLAYER_NAMES_KEY` (Task 4); `nameText` from `@fortytwo/client`.
- Produces: `NameSkeleton({ width?: string })`; `SeatPicker` gains `loading?: boolean`; `usePoke(..., nameOf: (playerId: string) => string | null)`.

- [ ] **Step 1: Make existing Match tests independent of the lookup, and write the failing ones** — in `apps/web/src/pages/Match.test.tsx`:

Replace `renderMatch` with:

```tsx
// Every test player is already named after their id ('p2', ...), as if looked up before, so seats
// show at once - most tests assert on those. `{ names: false }` starts with nothing looked up, for
// the tests about loading names.
function renderMatch({ names = true }: { names?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (names) {
    const ids = ['p1', 'p2', 'p3', 'p4', 'bot-1'];
    queryClient.setQueryData([PLAYER_NAMES_KEY, 'seeded'], new Map(ids.map((id) => [id, id])));
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Match />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
```

Import `PLAYER_NAMES_KEY` from `'../match/usePlayerNames'`. Update the `beforeEach` comment on `searchUsersMock.mockResolvedValue([])` to: `// Nothing found by default; renderMatch names the test players up front.`

Replace the test `"labels seats with players' display names, keeping the raw id for anyone without one"` with:

```tsx
    it("labels seats with players' display names, and anyone the lookup can't name by their seat", async () => {
      searchUsersMock.mockResolvedValue([
        { user_id: 'p2', displayName: 'Bob' },
        { user_id: 'p3', displayName: 'Cara' },
      ]);
      useMatchSocketMock.mockReturnValue({ match: playingMatch(), connected: true });
      renderMatch({ names: false });

      await waitFor(() => expect(seatOf('Bob')).toBeDefined());
      expect(seatOf('Cara')).toBeDefined();
      // p4 wasn't found, so it's called by its seat - never by its id.
      expect(seatOf('Player 4')).toBeDefined();
      expect(screen.queryByText('p4')).toBeNull();
      // The bid is credited by name too (p2 won it).
      expect(screen.getByText('Bob', { selector: '.contract-by' })).not.toBeNull();
      // The viewer is "You" and isn't looked up.
      expect(searchUsersMock).toHaveBeenCalledWith(['p2', 'p3', 'p4']);
    });

    it('shows a placeholder, not ids, while names load', () => {
      searchUsersMock.mockReturnValue(new Promise(() => {}));
      useMatchSocketMock.mockReturnValue({ match: playingMatch(), connected: true });
      renderMatch({ names: false });

      expect(screen.getAllByText('Loading name').length).toBeGreaterThan(0);
      for (const id of ['p2', 'p3', 'p4']) expect(screen.queryByText(id)).toBeNull();
      expect(screen.queryByText(/is bidding|'s lead|is playing/)).toBeNull();
    });
```

In the poke describe (around line 1990), add next to `"tells me when I'm poked"`:

```tsx
    it("doesn't name a poker whose name hasn't loaded", () => {
      searchUsersMock.mockReturnValue(new Promise(() => {}));
      useMatchSocketMock.mockReturnValue({ match: baseMatch(), connected: true });
      renderMatch({ names: false });
      const onPoke = useMatchSocketMock.mock.calls[0][2] as (from: string) => void;
      act(() => onPoke('p2'));

      expect(toastInfoMock).toHaveBeenCalledWith('You were poked', "It's your turn", 'center');
    });
```

- [ ] **Step 2: Run to see the new tests fail** — from `apps/web`: `npx vitest run src/pages/Match.test.tsx`. Expected: the three new/changed tests FAIL (`p4` shown, no "Loading name", "p2 poked you"); all others PASS.

- [ ] **Step 3: Add `NameSkeleton`** — `apps/web/src/components/NameSkeleton.tsx`:

```tsx
// Stands in for a player's name while it loads (match/usePlayerNames.ts), so the raw player id
// never shows. Styles in NameSkeleton.css.
import type { JSX } from 'react';
import './NameSkeleton.css';

export function NameSkeleton({ width = '5em' }: { width?: string }): JSX.Element {
  return (
    <span className="name-skeleton" style={{ width }}>
      <span className="visually-hidden">Loading name</span>
    </span>
  );
}
```

`apps/web/src/components/NameSkeleton.css`:

```css
/* A name still loading: a soft bar the height of a line of text, shimmering left to right. */

.name-skeleton {
  display: inline-block;
  height: 0.9em;
  vertical-align: middle;
  border-radius: 0.25em;
  background: linear-gradient(
    90deg,
    rgba(242, 234, 219, 0.08) 25%,
    rgba(242, 234, 219, 0.22) 50%,
    rgba(242, 234, 219, 0.08) 75%
  );
  background-size: 200% 100%;
  animation: name-skeleton-shimmer 1.4s ease-in-out infinite;
}

@keyframes name-skeleton-shimmer {
  from { background-position: 200% 0; }
  to { background-position: -200% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .name-skeleton {
    animation: none;
  }
}
```

- [ ] **Step 4: `Seat` and `SeatPicker` take a loading name**

`apps/web/src/components/Seat.tsx`: in `SeatProps`, `name: string | null;` with the comment `// Null while it loads.`; import `NameSkeleton`; render:

```tsx
        <span className="seat-name" title={name ?? undefined}>
          {name ?? <NameSkeleton />}
        </span>
```

`apps/web/src/components/SeatPicker.tsx`: add prop `loading = false` (`loading?: boolean`, comment: `// The taken seats' names are still loading (a match page opened from an invite).`), import `NameSkeleton`, and:

```tsx
            <span key={side} className={`seat-picker-seat seat-picker-${side} is-seated`}>
              {loading ? <NameSkeleton /> : name}
            </span>
```

```tsx
            <span className="seat-picker-hint">
              {partner == null ? 'open seat' : loading ? <>with <NameSkeleton width="3em" /></> : `with ${partner}`}
            </span>
```

- [ ] **Step 5: `usePoke` waits for the target's name** — in `apps/web/src/match/usePoke.ts`, `nameOf: (playerId: string) => string | null`, and:

```ts
    onSuccess: ({ delivered }, poked) => {
      const name = nameOf(poked.target);
      // A poke that reached nobody leaves the turn's poke unused, so the button stays.
      if (delivered === 'none') {
        toastInfo(name ? `${name} doesn't have notifications on` : "They don't have notifications on");
        return;
      }
      setPokedTurn(poked.turn);
      toastInfo(name ? `Poked ${name}` : 'Poked');
    },
```

```ts
  // Held back until the target's name has loaded, so the button never reads "Poke auth0|...".
  const showing =
    target != null && turn != null && idleTurn === turn && pokedTurn !== turn && nameOf(target) != null;
```

- [ ] **Step 6: Wire `Match.tsx`**

1. Imports: `nameText` from `@fortytwo/client` (add to the existing import block); `NameSkeleton` from `'../components/NameSkeleton'`; `usePlayerNames` from `'../match/usePlayerNames'`. Drop `useQuery` from the react-query import only if nothing else uses it (it is used by other queries — check with grep).
2. `pokedRef`: type `{ nameOf?: (playerId: string) => string | null; turn: string | null; moving: boolean }`; update its comment ("the sender's display name, once loaded"); the socket callback becomes:

```ts
    if (pokedRef.current.moving) return;
    const poker = pokedRef.current.nameOf?.(from) ?? null;
    toastInfo(poker ? `${poker} poked you` : 'You were poked', "It's your turn", 'center');
    setPokedTurn(pokedRef.current.turn);
```

3. Replace the `namesQuery` block (comment + `useQuery`) with:

```ts
  // Display names for everyone seated (match/usePlayerNames.ts). Until a name loads it reads null
  // here and the page shows a placeholder; one that can't be found reads "Player N". Never the id.
  const names = usePlayerNames(liveMatch?.players ?? [], myPlayerId, (ids) => client.searchUsers(ids));
  const nameOf = (playerId: string): string | null => nameText(names.nameFor(playerId));
```

4. `usePoke(liveMatch, myPlayerId, () => client.poke(matchId!), nameOf)`.
5. The `pokedRef` effect: `nameOf: (playerId) => nameText(names.nameFor(playerId))` in place of `names: namesQuery.data`, deps `[names, liveMatch, playing, bidMutation.isPending, setTrumpMutation.isPending]`.
6. New-hand toast effect:

```ts
    const opener = dealtGame.firstActionBy;
    const openerName = opener && opener !== myPlayerId ? nameText(names.nameFor(opener)) : null;
    // Before names load there's no one to credit; the title alone says the hand is out.
    const who = opener === myPlayerId ? 'You bid first' : openerName ? `${openerName} bids first` : undefined;
    toastInfo(`${dealtGame.name} dealt`, who, 'center');
  }, [dealtGame, myPlayerId, names]);
```

7. Seat picker branch:

```tsx
    const seats = [0, 1, 2, 3].map((position) => {
      const player = liveMatch.players.find((p) => p.position === position);
      return player ? (nameOf(player.playerId) ?? '') : null;
    });
```

and `<SeatPicker seats={seats} loading={!names.ready} … />`.

8. `nameFor` (for `matchStatus`, `MatchSummary`):

```ts
  // For sentences: only rendered once names are ready (see the status line), so '' never shows.
  const nameFor = (playerId: string | null): string => (playerId == null ? '' : (nameOf(playerId) ?? ''));
```

9. `seatPropsFor`: `name: nameOf(playerId),`.
10. Contract line: `<span className="contract-by">{nameOf(game.biddingPlayerId) ?? <NameSkeleton />}</span>`.
11. Status line: `{names.ready ? status : <NameSkeleton width="12em" />}` inside the existing `<p className="rail-status">`.
12. Poke button: `Poke {nameOf(poke.target)}`.

Then `grep -n "namesQuery\|?? id\|?? playerId\|?? from\|?? opener" apps/web/src/pages/Match.tsx` — expected: no matches.

- [ ] **Step 7: Run the web suite** — from `apps/web`: `npx vitest run`, then `npm run lint` and `npx tsc -b`. Expected: all PASS, no lint/type errors. (`Lobby.test.tsx` covers `SeatPicker` without `loading`.)

- [ ] **Step 8: Commit**

```bash
git add apps/web/src
git commit -m "Web: match screen shows a skeleton while names load and \"Player N\" when they can't, never ids (#72)"
```

---

### Task 6: Mobile `usePlayerNames` hook

**Files:**
- Create: `apps/mobile/src/match/usePlayerNames.ts`
- Create: `apps/mobile/src/match/__tests__/usePlayerNames.test.tsx`

**Interfaces:**
- Consumes: `playerName`, `mergeNames`, `missingIds`, `PlayerName`, `PublicUser` from `@fortytwo/client` (Task 4).
- Produces: `usePlayerNames(players, myPlayerId, searchUsers): { nameFor: (playerId: string) => PlayerName; ready: boolean }`, `PLAYER_NAMES_KEY` — same contract as the web hook.

- [ ] **Step 1: Write the failing tests** — `apps/mobile/src/match/__tests__/usePlayerNames.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PublicUser } from '@fortytwo/client';
import { usePlayerNames } from '../usePlayerNames';

const seated = (...ids: string[]) => ids.map((playerId, position) => ({ playerId, position }));
const echo = (ids: string[]): PublicUser[] => ids.map((id) => ({ user_id: id, displayName: `name-${id}` }));

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { wrapper };
}

describe('usePlayerNames', () => {
  it('looks up only a newcomer, keeping the names already shown', async () => {
    const search = jest.fn(async (ids: string[]) => echo(ids));
    const { wrapper } = setup();
    const { result, rerender } = await renderHook(
      ({ ids }: { ids: string[] }) => usePlayerNames(seated(...ids), 'p1', search),
      { wrapper, initialProps: { ids: ['p1', 'p2'] } }
    );
    await waitFor(() => expect(result.current.nameFor('p2')).toEqual({ status: 'loaded', name: 'name-p2' }));
    expect(search).toHaveBeenCalledWith(['p2']);

    await rerender({ ids: ['p1', 'p2', 'p3'] });
    expect(result.current.nameFor('p2')).toEqual({ status: 'loaded', name: 'name-p2' });
    expect(result.current.ready).toBe(false);

    await waitFor(() => expect(result.current.nameFor('p3')).toEqual({ status: 'loaded', name: 'name-p3' }));
    expect(search).toHaveBeenLastCalledWith(['p3']);
  });

  it('calls a player the lookup did not find by their seat', async () => {
    const { wrapper } = setup();
    const { result } = await renderHook(() => usePlayerNames(seated('p1', 'p2'), 'p1', async () => []), { wrapper });
    await waitFor(() => expect(result.current.nameFor('p2')).toEqual({ status: 'failed', name: 'Player 2' }));
  });
});
```

(`renderHook`/`rerender` are awaited, as in `usePoke.test.tsx`; if `rerender` isn't async in this library version, drop that `await`.)

- [ ] **Step 2: Run to see it fail** — from `apps/mobile`: `npx jest src/match/__tests__/usePlayerNames.test.tsx`. Expected: FAIL, cannot find module `../usePlayerNames`.

- [ ] **Step 3: Implement** — `apps/mobile/src/match/usePlayerNames.ts`: the same code as `apps/web/src/match/usePlayerNames.ts` from Task 4 Step 7, with the header comment's last line changed to end `... they're always "You". The web app's match/usePlayerNames.ts is the same.` Imports are identical (`@tanstack/react-query`, `@fortytwo/client`, `react`). Drop the `eslint-disable` line if the mobile app has no such lint rule (it runs `tsc` only).

- [ ] **Step 4: Run to see it pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/match/usePlayerNames.ts apps/mobile/src/match/__tests__/usePlayerNames.test.tsx
git commit -m "Mobile: player names hook that only looks up newcomers (#72)"
```

---

### Task 7: Mobile match screen shows skeletons and "Player N", never ids

**Files:**
- Create: `apps/mobile/src/components/NameSkeleton.tsx`
- Modify: `apps/mobile/src/components/Table.tsx` (`SeatInfo.name: string | null`)
- Modify: `apps/mobile/src/components/SeatPicker.tsx`, `apps/mobile/src/components/JoinMatchPanel.tsx` (`loading` prop)
- Modify: `apps/mobile/src/match/usePoke.ts`, `apps/mobile/src/match/__tests__/usePoke.test.tsx`
- Modify: `apps/mobile/src/app/match/[id].tsx`
- Modify: `apps/mobile/src/dev/devMatches.ts` (bots named like the server)
- Modify: `apps/mobile/src/components/__tests__/components.test.tsx` (SeatPicker loading)

**Interfaces:**
- Consumes: `usePlayerNames` (Task 6), `nameText` from `@fortytwo/client`, `botDisplayName`/`isBot` from `@fortytwo/rules`.
- Produces: `NameSkeleton({ width?: DimensionValue })`; `SeatPicker`/`JoinMatchPanel` gain `loading?: boolean`; `usePoke(..., nameOf: (playerId: string) => string | null)`.

- [ ] **Step 1: Write the failing tests**

In `apps/mobile/src/match/__tests__/usePoke.test.tsx` add:

```tsx
  it("holds the poke back until the target's name has loaded", async () => {
    jest.useFakeTimers();
    const fresh = dealt();
    const turn = fresh.currentGame.currentPlayerId!;
    const me = ['p1', 'p2', 'p3', 'p4'].find((id) => id !== turn)!;
    const match = { ...fresh, updatedOn: new Date(Date.now() - POKE_IDLE_MS - 1000).toISOString() };
    let named = false;

    const { result, rerender } = await renderHook(() => usePoke(match, me, jest.fn(), () => (named ? 'Bob' : null)), {
      wrapper,
    });
    await act(async () => {
      jest.advanceTimersByTime(0);
    });
    expect(result.current.target).toBeNull();

    named = true;
    await rerender({});
    expect(result.current.target).toBe(turn);
  });
```

In `apps/mobile/src/components/__tests__/components.test.tsx`, next to the existing SeatPicker tests (find them with `grep -n "SeatPicker" apps/mobile/src/components/__tests__/components.test.tsx`; follow their render/await style), add:

```tsx
  it('shows placeholders, not names, for taken seats while names load', async () => {
    await render(<SeatPicker seats={['', null, null, null]} loading disabled={false} onPick={jest.fn()} />);
    expect(screen.getAllByLabelText('Loading name').length).toBeGreaterThan(0);
  });
```

- [ ] **Step 2: Run to see them fail** — from `apps/mobile`: `npx jest src/match/__tests__/usePoke.test.tsx src/components/__tests__/components.test.tsx`. Expected: the two new tests FAIL.

- [ ] **Step 3: Add `NameSkeleton`** — `apps/mobile/src/components/NameSkeleton.tsx`:

```tsx
// Stands in for a player's name while it loads (match/usePlayerNames.ts), so the raw player id
// never shows: a soft bar the height of a line of text, gently pulsing.
import { useEffect, useRef } from 'react';
import { Animated, type DimensionValue } from 'react-native';
import { colors } from './theme';

export function NameSkeleton({ width = 72 }: { width?: DimensionValue }) {
  const opacity = useRef(new Animated.Value(0.15)).current;
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.15, duration: 700, useNativeDriver: true }),
      ])
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity]);
  return (
    <Animated.View
      accessibilityLabel="Loading name"
      style={{ width, height: 12, borderRadius: 4, backgroundColor: colors.bone, opacity }}
    />
  );
}
```

- [ ] **Step 4: `Table`, `SeatPicker`, `JoinMatchPanel` take a loading name**

`Table.tsx`: `SeatInfo.name: string | null;` (comment `// Null while it loads.`); in `SeatPlate`, `accessibilityLabel={`${info.name ?? 'Loading name'}${info.isActive ? ', to act' : ''}`}` and

```tsx
        {info.name != null ? (
          <Text style={styles.name} numberOfLines={1}>
            {info.name}
          </Text>
        ) : (
          <View style={styles.nameSkeleton}>
            <NameSkeleton />
          </View>
        )}
```

with `nameSkeleton: { flex: 1 },` added to the styles beside `name`. Import `NameSkeleton` from `'./NameSkeleton'`.

`SeatPicker.tsx`: `loading?: boolean` in `SeatPickerProps` (comment `// The taken seats' names are still loading (a match opened from an invite).`), default `false`; taken seat renders `{loading ? <NameSkeleton width={64} /> : <Text …>{name}</Text>}`; open seat: `accessibilityLabel={`Sit here${partner != null && !loading ? `, with ${partner}` : ''}`}` and the hint:

```tsx
        {partner != null && loading ? (
          <NameSkeleton width={48} />
        ) : (
          <Text style={styles.hint} numberOfLines={1}>
            {partner != null ? `with ${partner}` : 'open seat'}
          </Text>
        )}
```

`JoinMatchPanel.tsx`: `loading?: boolean` in props, passed through: `<SeatPicker seats={seats} loading={loading} disabled={joining} onPick={onPick} />`.

- [ ] **Step 5: `usePoke`** — `apps/mobile/src/match/usePoke.ts`: the same three changes as the web's in Task 5 Step 5 (`nameOf` returns `string | null`; the `onSuccess` body with `name ? … : …` wording; `showing` also requires `nameOf(target) != null` with its comment).

- [ ] **Step 6: Wire `app/match/[id].tsx`**

1. Imports: `nameText` from `@fortytwo/client`; `NameSkeleton` from `'@/components/NameSkeleton'`; `usePlayerNames` from `'@/match/usePlayerNames'`.
2. `pokedRef`: `useRef<{ nameOf?: (playerId: string) => string | null; moving: boolean }>({ moving: false })`; socket callback:

```ts
    if (pokedRef.current.moving) return;
    const poker = pokedRef.current.nameOf?.(from) ?? null;
    toastInfo(poker ? `${poker} poked you` : 'You were poked', "It's your turn", 'center');
```

3. Replace the `seatedIds`/`names` `useQuery` block with:

```ts
  // Display names for everyone seated (match/usePlayerNames.ts). Until a name loads it reads null
  // here and the screen shows a placeholder; one that can't be found reads "Player N". Never the id.
  const names = usePlayerNames(liveMatch?.players ?? [], myPlayerId, (ids) => api.searchUsers(ids));
  const nameOf = (playerId: string): string | null => nameText(names.nameFor(playerId));
  const poke = usePoke(liveMatch, myPlayerId, () => api.poke(id), nameOf);
```

4. The `pokedRef` effect: `pokedRef.current = { nameOf: (playerId) => nameText(names.nameFor(playerId)), moving: … }`, deps `[names, playing, bid.isPending, trump.isPending]`.
5. Join branch: `return player ? (nameOf(player.playerId) ?? '') : null;` and `<JoinMatchPanel seats={seats} loading={!names.ready} … />`.
6. `nameFor`:

```ts
  // For sentences: only rendered once names are ready (see the status and contract lines).
  const nameFor = (playerId: string | null) => (playerId == null ? '' : (nameOf(playerId) ?? ''));
```

7. `seatInfo`: `name: nameOf(playerId),`.
8. Contract line (line ~437): `{contractBid && (names.ready ? <Text style={styles.contractText}>{contractBid}</Text> : <NameSkeleton width={120} />)}`.
9. Status line (line ~572): wrap `{status}` as `{names.ready ? status : null}` inside the `<Text>`, and render `{!names.ready && <NameSkeleton width={160} />}` right after that `<Text>` inside `styles.statusLine`.
10. Poke button: `Poke {nameOf(poke.target)}`.

Then `grep -n "names.data\|seatedIds\|?? playerId\|?? from\|playerNames" "apps/mobile/src/app/match/[id].tsx"` — expected: no matches. Remove `useQuery` from imports only if unused (it is used by `matchQuery` and `config`).

- [ ] **Step 7: Dev fake names bots like the server** — `apps/mobile/src/dev/devMatches.ts` line ~132:

```ts
  searchUsers: (ids) =>
    later(300, () =>
      ids.map((user_id): PublicUser => ({ user_id, displayName: isBot(user_id) ? botDisplayName(user_id) : (NAMES[user_id] ?? user_id) }))
    ),
```

importing `botDisplayName, isBot` from `@fortytwo/rules` (merge with any existing `@fortytwo/rules` import).

- [ ] **Step 8: Run the mobile suite and typecheck** — from `apps/mobile`: `npx jest` then `npm run typecheck`. Expected: PASS, no type errors.

- [ ] **Step 9: Look at it in the emulator** — use the `mobile-emulator` skill. Temporarily change the dev fake's `later(300, …)` for `searchUsers` to `later(4000, …)`, open a dev match, and screenshot: seat plates, status line and contract line show pulsing bars (no ids) for ~4s, then names; bots read "Bot 1". Revert the delay to 300 before committing.

- [ ] **Step 10: Commit**

```bash
git add apps/mobile/src
git commit -m "Mobile: match screen shows a skeleton while names load and \"Player N\" when they can't, never ids (#72)"
```

---

### Task 8: Whole-branch check

- [ ] **Step 1: Run every suite once** — worker (Global Constraints command), `npx vitest run` in `packages/rules` and `packages/client`, `npx vitest run` + `npm run lint` + `npx tsc -b` in `apps/web`, `npx jest` + `npm run typecheck` in `apps/mobile`. Expected: all PASS.
- [ ] **Step 2: Confirm no raw-id fallbacks remain** — `grep -rn "?? id)\|?? playerId)\|?? from}\|names.get(" apps/web/src/pages/Match.tsx "apps/mobile/src/app/match/[id].tsx" apps/web/src/match apps/mobile/src/match`. Expected: no matches.
- [ ] **Step 3: Apply the migration locally** — from `apps/worker`: `npx wrangler d1 migrations apply DB --local` (use the binding/database name from `wrangler.toml` if it differs). Expected: `0007_users.sql` applied. The remote migration is applied at deploy, not by this plan.
