# Leave/Cancel, Expiry, and Lobby Paging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let players leave (or cancel) a match before its first deal, delete active matches idle for 14 days with a daily cron sweep, and page the lobby lists 20 at a time.

**Architecture:** A pure `removePlayer` in `@fortytwo/rules`; a `MatchDO.leave`/`expire` pair that share one `destroy()` (alarm off, sockets closed with 4404, storage wiped); routes and the cron sweep own D1 cleanup through `deleteFromLobbyIndex`. Lobby queries switch to keyset paging on `(updated_on, id)`, and the web lobby to `useInfiniteQuery`.

**Tech Stack:** Cloudflare Workers + Durable Objects + D1, Hono, vitest + `@cloudflare/vitest-pool-workers`, React 19 + TanStack Query v5, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-30-leave-expire-paginate-design.md`

## Global Constraints

- Idle threshold: `MATCH_IDLE_DAYS = 14`; only `status = 'active'` matches expire. Completed matches are never deleted.
- Cron: `crons = ["0 9 * * *"]` (daily, 09:00 UTC). Sweep batches: `LIMIT 100`, at most 10 batches per run.
- Page size: `LOBBY_PAGE_SIZE = 20`, fixed server-side. Order: `updated_on DESC, id DESC`. Cursor: base64url of `` `${updatedOn}|${id}` ``.
- Deleted-match socket close code: `4404`, reason `"Match deleted"`.
- Leaving is allowed only while `hasBeenDealt(match)` is false. Bots never count as humans (`isBot`).
- D1 deletes go `match_players` first, then `matches` (foreign key), in one `db.batch`.
- The DO never writes or deletes D1 rows for leave/expire; the route or sweep does.
- Comment style: match the surrounding files - full-sentence comments explaining *why*, no JSDoc.
- All commands run from `cloudflare/` (the npm workspace root). Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Leaving between hands.** After a hand's last trick every hand is empty again; a player must still be refused. → `removePlayer` test with filed games / played tricks (Task 1).
2. **Two matches with the same `updated_on` straddling a page boundary.** Neither may be skipped or repeated. → tie-break paging test (Task 4).
3. **A match that moves to page 1 while you're on page 2.** It must not render twice. → de-dupe test in Lobby (Task 5).
4. **The last human leaving also receives the 4404 close on their own socket.** They must not get a spurious "This match was deleted" toast. → Match page test (Task 6).
5. **One DO failing during the sweep.** The sweep must finish the rest and not re-query the same row forever. → injected-failure sweep test (Task 3).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/rules/src/matchEngine.ts` | + `hasBeenDealt`, `hasHumanPlayers`, `removePlayer` |
| `packages/rules/src/index.ts` | export the three |
| `packages/rules/src/matchEngine.test.ts` | tests for them |
| `packages/api-types/src/index.ts` | + `MatchPage` |
| `apps/worker/src/lobby.ts` | + `deleteFromLobbyIndex`; paged `listActive`/`listCompleted`/`listJoinable` |
| `apps/worker/src/cursor.ts` (new) | encode/decode the opaque lobby cursor |
| `apps/worker/src/matchDO.ts` | + `destroy()`, `leave()`, `expire()`; `LeaveResult`, `ExpireOutcome`, `MATCH_DELETED_CLOSE_CODE` |
| `apps/worker/src/expiry.ts` (new) | the daily sweep |
| `apps/worker/src/routes/matches.ts` | + `DELETE /:id/players`; paged `GET /` |
| `apps/worker/src/index.ts` | named `app` export; default `{ fetch, scheduled }` |
| `apps/worker/wrangler.toml` | `[triggers]` cron |
| `apps/worker/migrations/0004_matches_status_updated.sql` (new) | index |
| `apps/worker/test/matchDOLeave.test.ts` (new) | DO leave/destroy |
| `apps/worker/test/expiry.test.ts` (new) | sweep + scheduled handler |
| `apps/worker/test/cursor.test.ts` (new) | cursor round-trip |
| `apps/worker/test/lobby.test.ts`, `test/routes.matches.test.ts` | updated for paging; + leave route |
| `apps/web/src/api/client.ts` | `listMatches(filter, cursor?)` → `MatchPage`; + `leaveMatch` |
| `apps/web/src/pages/Lobby.tsx` (+ `.css`, `.test.tsx`) | infinite query, Load more, first-page refresh |
| `apps/web/src/api/useMatchSocket.ts` (+ test) | 4404 → no reconnect, `deleted` flag |
| `apps/web/src/pages/Match.tsx` (+ test) | Leave/Cancel button, deleted redirect, not-found error |

---

### Task 1: Rules - `hasBeenDealt`, `hasHumanPlayers`, `removePlayer`

**Files:**
- Modify: `cloudflare/packages/rules/src/matchEngine.ts` (append after `takeSeat`/`seatPlayer`, ~line 165)
- Modify: `cloudflare/packages/rules/src/index.ts:45-58`
- Test: `cloudflare/packages/rules/src/matchEngine.test.ts`

**Interfaces:**
- Produces:
  - `hasBeenDealt(match: MatchState): boolean`
  - `hasHumanPlayers(match: MatchState): boolean`
  - `removePlayer(match: MatchState, playerId: string): MatchState` - throws `ValidationError`
  - all three exported from `@fortytwo/rules`

- [ ] **Step 1: Write the failing tests**

Add `removePlayer, hasBeenDealt, hasHumanPlayers` to the `./matchEngine` import at the top of `matchEngine.test.ts`, then append:

```ts
describe('leaving a match', () => {
  // p1 created the match; p2 sat at seat 1 and p3 at seat 2. Nothing dealt yet.
  function threeSeated(): MatchState {
    let match = createMatch('p1');
    match = takeSeat(match, 'p2', Positions.Second);
    match = takeSeat(match, 'p3', Positions.Third);
    return match;
  }

  describe('hasBeenDealt', () => {
    it('is false for a table still waiting for players', () => {
      expect(hasBeenDealt(threeSeated())).toBe(false);
    });

    it('is true once the 4th seat deals', () => {
      expect(hasBeenDealt(takeSeat(threeSeated(), 'p4', Positions.Fourth, fullDeck()))).toBe(true);
    });

    it('counts hidden hands, so it works on a client view', () => {
      const match = threeSeated();
      const hidden = {
        ...match,
        currentGame: {
          ...match.currentGame,
          hands: match.currentGame.hands.map((h) => ({ ...h, dominoes: [], hiddenCount: 7 })),
        },
      };
      expect(hasBeenDealt(hidden)).toBe(true);
    });

    it('stays true between hands, when every hand is empty again', () => {
      const match = threeSeated();
      const afterLastTrick = {
        ...match,
        currentGame: { ...match.currentGame, tricks: [createTrick()] },
      };
      expect(hasBeenDealt(afterLastTrick)).toBe(true);
      const withFiledGame = { ...match, games: { [Teams.TeamA]: [match.currentGame] } };
      expect(hasBeenDealt(withFiledGame)).toBe(true);
    });
  });

  describe('hasHumanPlayers', () => {
    it('ignores bots', () => {
      expect(hasHumanPlayers(createMatch('bot-1'))).toBe(false);
      expect(hasHumanPlayers(threeSeated())).toBe(true);
    });
  });

  describe('removePlayer', () => {
    it("removes the player's seat and hand", () => {
      const next = removePlayer(threeSeated(), 'p2');
      expect(next.players.map((p) => p.playerId)).toEqual(['p1', 'p3']);
      expect(next.currentGame.hands.map((h) => h.playerId)).toEqual(['p1', 'p3']);
    });

    it('hands the opening turn to the lowest remaining seat when the creator leaves', () => {
      const next = removePlayer(threeSeated(), 'p1');
      expect(next.currentGame.firstActionBy).toBe('p2');
      expect(next.currentGame.currentPlayerId).toBe('p2');
    });

    it('leaves the opener alone when someone else leaves', () => {
      const next = removePlayer(threeSeated(), 'p3');
      expect(next.currentGame.firstActionBy).toBe('p1');
      expect(next.currentGame.currentPlayerId).toBe('p1');
    });

    it('can remove the last player', () => {
      const next = removePlayer(createMatch('p1'), 'p1');
      expect(next.players).toEqual([]);
      expect(next.currentGame.hands).toEqual([]);
    });

    it('refuses someone who is not seated', () => {
      expect(() => removePlayer(threeSeated(), 'p9')).toThrow(ValidationError);
    });

    it('refuses once the dominoes are dealt', () => {
      const dealt = takeSeat(threeSeated(), 'p4', Positions.Fourth, fullDeck());
      expect(() => removePlayer(dealt, 'p2')).toThrow("You can't leave once the dominoes are dealt");
    });

    it('refuses on a finished match', () => {
      expect(() => removePlayer({ ...threeSeated(), winningTeam: Teams.TeamA }, 'p2')).toThrow(ValidationError);
    });
  });
});
```

`createTrick` is already imported from `./trick` in this file; `fullDeck`, `Positions`, `Teams`, `ValidationError` are too.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @fortytwo/rules -- src/matchEngine.test.ts`
Expected: FAIL - `removePlayer is not a function` (or similar import error).

- [ ] **Step 3: Implement**

In `matchEngine.ts`, add `assertIsMatchPlayer` to the existing `./validation` import list (it already imports `assertActive` etc. from there), then add after `seatPlayer`:

```ts
// Whether any hand has been dealt in this match yet. Hands are empty again after a hand's last
// trick, so empty hands alone don't mean "not dealt": a played trick or a filed game counts too.
// A hidden hand (view.ts) counts by its `hiddenCount`, so this also works on a client's view.
export function hasBeenDealt(match: MatchState): boolean {
  return (
    Object.values(match.games).some((games) => (games?.length ?? 0) > 0) ||
    match.currentGame.tricks.length > 0 ||
    match.currentGame.hands.some((h) => (h.hiddenCount ?? h.dominoes.length) > 0)
  );
}

export function hasHumanPlayers(match: MatchState): boolean {
  return match.players.some((p) => !isBot(p.playerId));
}

// Takes a player's seat and hand back out of a match that hasn't been dealt yet. If they were
// due to open (the creator always is), the lowest remaining seat opens instead. Removing the last
// player is allowed; the caller deletes the empty match.
export function removePlayer(match: MatchState, playerId: string): MatchState {
  assertActive(match);
  assertIsMatchPlayer(match, playerId);
  if (hasBeenDealt(match)) throw new ValidationError("You can't leave once the dominoes are dealt");

  const players = match.players.filter((p) => p.playerId !== playerId);
  const opener = [...players].sort((a, b) => a.position - b.position)[0]?.playerId;
  const replaceLeaver = (id: string | null) => (id === playerId && opener !== undefined ? opener : id);

  const currentGame: Game = {
    ...match.currentGame,
    hands: match.currentGame.hands.filter((h) => h.playerId !== playerId),
    firstActionBy: replaceLeaver(match.currentGame.firstActionBy),
    currentPlayerId: replaceLeaver(match.currentGame.currentPlayerId),
  };

  return { ...match, players, currentGame, updatedOn: now() };
}
```

In `index.ts`, add `removePlayer`, `hasBeenDealt`, `hasHumanPlayers` to the `export { ... } from './matchEngine';` list.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @fortytwo/rules`
Expected: PASS (whole rules suite).

- [ ] **Step 5: Commit**

```bash
git add packages/rules/src/matchEngine.ts packages/rules/src/index.ts packages/rules/src/matchEngine.test.ts ../docs/superpowers
git commit -m "Add removePlayer and hasBeenDealt to the rules engine (#18)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Worker - leave a match (DO `leave`/`destroy`, `DELETE /api/matches/:id/players`)

**Files:**
- Modify: `cloudflare/apps/worker/src/lobby.ts` (append)
- Modify: `cloudflare/apps/worker/src/matchDO.ts`
- Modify: `cloudflare/apps/worker/src/routes/matches.ts`
- Create: `cloudflare/apps/worker/test/matchDOLeave.test.ts`
- Modify: `cloudflare/apps/worker/test/routes.matches.test.ts` (new `describe` at the end of the top-level `describe('match routes')`)

**Interfaces:**
- Consumes: `removePlayer`, `hasHumanPlayers` from `@fortytwo/rules` (Task 1)
- Produces:
  - `deleteFromLobbyIndex(db: D1Database, matchId: string): Promise<void>` in `lobby.ts`
  - `export const MATCH_DELETED_CLOSE_CODE = 4404;` in `matchDO.ts`
  - `export type LeaveResult = { deleted: true } | { deleted: false; match: MatchState };`
  - `MatchDO.leave(playerId: string): Promise<MatchResult<LeaveResult>>`
  - `MatchDO` private `destroy(): Promise<void>` (Task 3 calls it from `expire`)
  - Route `DELETE /api/matches/:id/players` → `204` empty, or `200` + match view

- [ ] **Step 1: Write the failing DO tests**

Create `test/matchDOLeave.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Positions } from '@fortytwo/rules';
import type { Env } from '../src/index';

const testEnv = env as unknown as Env;

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}

async function storedKeys(stub: ReturnType<typeof stubFor>): Promise<number> {
  return runInDurableObject(stub, async (_instance, state) => (await state.storage.list()).size);
}

describe('MatchDO leave', () => {
  it('removes a joiner and keeps the match', async () => {
    const stub = stubFor('leave-joiner');
    await stub.create('p1', 'leave-joiner');
    await stub.takeSeat('p2', Positions.Second);

    const result = await stub.leave('p2');

    expect(result).toMatchObject({ ok: true, value: { deleted: false } });
    if (!result.ok || result.value.deleted) throw new Error('expected a kept match');
    expect(result.value.match.players.map((p) => p.playerId)).toEqual(['p1']);
    const reloaded = await stub.getMatch();
    expect(reloaded.ok && reloaded.value.players).toHaveLength(1);
  });

  it('deletes the match and wipes storage when the last human leaves', async () => {
    const stub = stubFor('leave-last-human');
    await stub.create('p1', 'leave-last-human');

    const result = await stub.leave('p1');

    expect(result).toEqual({ ok: true, value: { deleted: true } });
    expect(await stub.getMatch()).toMatchObject({ ok: false, status: 404 });
    expect(await storedKeys(stub)).toBe(0);
  });

  it('deletes a match left with only bots', async () => {
    const stub = stubFor('leave-bots-only');
    await stub.create('p1', 'leave-bots-only');
    await stub.takeSeat('bot-1', Positions.Second);

    expect(await stub.leave('p1')).toEqual({ ok: true, value: { deleted: true } });
  });

  it('refuses a non-player with a 400', async () => {
    const stub = stubFor('leave-outsider');
    await stub.create('p1', 'leave-outsider');

    expect(await stub.leave('p9')).toMatchObject({ ok: false, status: 400 });
  });

  it('is a 404 for a match that is already gone', async () => {
    expect(await stubFor('leave-never-created').leave('p1')).toMatchObject({ ok: false, status: 404 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w @fortytwo/worker -- test/matchDOLeave.test.ts`
Expected: FAIL - `stub.leave is not a function`.

- [ ] **Step 3: Implement `deleteFromLobbyIndex`, `destroy`, `leave`**

Append to `lobby.ts`:

```ts
// Drops a deleted match from the lobby: its seats first, then the match row they reference.
export async function deleteFromLobbyIndex(db: D1Database, matchId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM match_players WHERE match_id = ?').bind(matchId),
    db.prepare('DELETE FROM matches WHERE id = ?').bind(matchId),
  ]);
}
```

In `matchDO.ts`: add `removePlayer` and `hasHumanPlayers` to the `@fortytwo/rules` import. Below `BOT_MOVE_DELAY_MS` add:

```ts
// Sent to every socket when its match is deleted, so clients stop reconnecting to it. In the
// 4000-4999 range the WebSocket protocol leaves for applications; the web app's useMatchSocket
// knows it by the same number.
export const MATCH_DELETED_CLOSE_CODE = 4404;

export type LeaveResult = { deleted: true } | { deleted: false; match: MatchState };
```

Add the methods after `takeSeat`:

```ts
  // Takes a player back out of a match that hasn't been dealt. When no human is left the match is
  // deleted outright - that's also how a creator cancels a match nobody joined. The caller drops
  // the lobby rows (routes/matches.ts), as routes already own D1 syncing.
  leave(playerId: string): Promise<MatchResult<LeaveResult>> {
    return this.read(async (match): Promise<LeaveResult> => {
      const next = removePlayer(match, playerId);
      if (!hasHumanPlayers(next)) {
        await this.destroy();
        return { deleted: true };
      }
      await this.save(next);
      this.broadcast(next);
      await this.scheduleBotsIfNeeded(next);
      return { deleted: false, match: next };
    });
  }
```

And a private method near `save`:

```ts
  // Deletes this match for good: no bot move may fire afterwards, every client is told to stop
  // reconnecting, and storage is wiped so a later call finds no match (404).
  private async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    for (const ws of this.ctx.getWebSockets()) {
      ws.close(MATCH_DELETED_CLOSE_CODE, 'Match deleted');
    }
    await this.ctx.storage.deleteAll();
  }
```

- [ ] **Step 4: Run DO tests to verify they pass**

Run: `npm test -w @fortytwo/worker -- test/matchDOLeave.test.ts`
Expected: PASS.

- [ ] **Step 5: Add a socket test for the 4404 close**

Append to `test/matchDOLeave.test.ts` (needs a signed token; copy the JWKS `beforeAll` + `signToken` + `openSocket` helpers verbatim from `test/matchDOSocket.test.ts` lines 1-88 into this file's top, keeping the same `KEY_ID` value - each test file has its own isolated module scope):

```ts
it('closes connected sockets with 4404 when the match is deleted', async () => {
  const stub = stubFor('leave-socket-close');
  await stub.create('p1', 'leave-socket-close');
  const token = await signToken({ sub: 'p1' });
  const { ws } = await openSocket(stub, `/ws?token=${token}`);
  if (!ws) throw new Error('expected a socket');

  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', (e) => resolve(e as CloseEvent)));
  await stub.leave('p1');

  expect((await closed).code).toBe(4404);
});
```

Run: `npm test -w @fortytwo/worker -- test/matchDOLeave.test.ts` → PASS.

- [ ] **Step 6: Write failing route tests**

In `test/routes.matches.test.ts`, inside `describe('match routes', ...)`, add:

```ts
  describe('DELETE /api/matches/:id/players', () => {
    async function seatCount(matchId: string) {
      const row = await testEnv.DB.prepare('SELECT player_count FROM matches WHERE id = ?')
        .bind(matchId)
        .first<{ player_count: number }>();
      return row?.player_count ?? null;
    }

    it('lets a joiner leave and updates the lobby row', async () => {
      const p1 = await signToken('p1');
      const p2 = await signToken('p2');
      const { id } = (await (await api('/api/matches', p1, { method: 'POST' })).json()) as { id: string };
      await api(`/api/matches/${id}/players`, p2, { method: 'POST', body: JSON.stringify({ position: 1 }) });

      const res = await api(`/api/matches/${id}/players`, p2, { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(((await res.json()) as { players: unknown[] }).players).toHaveLength(1);
      expect(await seatCount(id)).toBe(1);
    });

    it('deletes the match and its lobby rows when the creator cancels', async () => {
      const p1 = await signToken('p1');
      const { id } = (await (await api('/api/matches', p1, { method: 'POST' })).json()) as { id: string };

      const res = await api(`/api/matches/${id}/players`, p1, { method: 'DELETE' });

      expect(res.status).toBe(204);
      expect(await seatCount(id)).toBeNull();
      const seats = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM match_players WHERE match_id = ?')
        .bind(id)
        .first<{ n: number }>();
      expect(seats?.n).toBe(0);
      expect((await api(`/api/matches/${id}`, p1)).status).toBe(404);
    });

    it('refuses to let a player leave once the hand is dealt', async () => {
      const tokens = await Promise.all(['p1', 'p2', 'p3', 'p4'].map((sub) => signToken(sub)));
      const { id } = (await (await api('/api/matches', tokens[0], { method: 'POST' })).json()) as { id: string };
      for (const [position, token] of [[1, tokens[1]], [2, tokens[2]], [3, tokens[3]]] as const) {
        await api(`/api/matches/${id}/players`, token, { method: 'POST', body: JSON.stringify({ position }) });
      }

      const res = await api(`/api/matches/${id}/players`, tokens[1], { method: 'DELETE' });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { title: string }).title).toBe("You can't leave once the dominoes are dealt");
    });

    it('refuses someone who is not seated', async () => {
      const p1 = await signToken('p1');
      const outsider = await signToken('p9');
      const { id } = (await (await api('/api/matches', p1, { method: 'POST' })).json()) as { id: string };

      expect((await api(`/api/matches/${id}/players`, outsider, { method: 'DELETE' })).status).toBe(400);
    });
  });
```

Run: `npm test -w @fortytwo/worker -- test/routes.matches.test.ts`
Expected: FAIL - DELETE returns 404 (no route).

- [ ] **Step 7: Implement the route**

In `routes/matches.ts`, add `deleteFromLobbyIndex` to the `../lobby` import, then after `matches.patch('/:id/players', ...)`:

```ts
// Leaves a match before its first deal. The last human out deletes it - which is how a creator
// cancels a match nobody joined - so its lobby rows go too and the reply has no match to show.
matches.delete('/:id/players', async (c) => {
  const matchId = c.req.param('id');
  const result = await matchStub(c.env, matchId).leave(c.get('user').sub);
  if (!result.ok) return refusal(c, result);
  if (result.value.deleted) {
    await deleteFromLobbyIndex(c.env.DB, matchId);
    return c.body(null, 204);
  }
  await syncLobbyIndex(c.env.DB, result.value.match);
  return c.json(matchViewFor(result.value.match, c.get('user').sub));
});
```

- [ ] **Step 8: Run worker suite**

Run: `npm test -w @fortytwo/worker`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/worker/src/lobby.ts apps/worker/src/matchDO.ts apps/worker/src/routes/matches.ts apps/worker/test/matchDOLeave.test.ts apps/worker/test/routes.matches.test.ts
git commit -m "Let players leave a match before the deal; last human out deletes it (#18)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Worker - daily expiry sweep

**Files:**
- Create: `cloudflare/apps/worker/migrations/0004_matches_status_updated.sql`
- Modify: `cloudflare/apps/worker/src/matchDO.ts`
- Create: `cloudflare/apps/worker/src/expiry.ts`
- Modify: `cloudflare/apps/worker/src/index.ts`
- Modify: `cloudflare/apps/worker/wrangler.toml`
- Modify: `cloudflare/apps/worker/test/routes.matches.test.ts:5` (import)
- Create: `cloudflare/apps/worker/test/expiry.test.ts`

**Interfaces:**
- Consumes: `MatchDO.destroy()` (Task 2), `deleteFromLobbyIndex`, `syncLobbyIndex` (lobby.ts)
- Produces:
  - `export type ExpireOutcome = { outcome: 'expired' } | { outcome: 'missing' } | { outcome: 'fresh'; match: MatchState };` in `matchDO.ts`
  - `MatchDO.expire(cutoff: string): Promise<ExpireOutcome>`
  - `expireIdleMatches(env: Env, now: number, expireOne?: ExpireOne): Promise<ExpirySummary>` in `expiry.ts`, with `export type ExpireOne = (matchId: string, cutoff: string) => Promise<ExpireOutcome>;` and `export interface ExpirySummary { expired: number; refreshed: number; orphaned: number; failed: number }`
  - `export const MATCH_IDLE_DAYS = 14;`
  - `index.ts`: `export { app }` (named) and `export default { fetch, scheduled }`

- [ ] **Step 1: Migration**

Create `migrations/0004_matches_status_updated.sql`:

```sql
-- Serves the two queries that scan matches by status and age: the daily expiry sweep (oldest
-- active first) and the lobby's paged lists (newest first, keyset on updated_on then id).
CREATE INDEX idx_matches_status_updated ON matches(status, updated_on);
```

(The test pool applies every file in `migrations/` via `test/applyMigrations.ts`, so no test config changes.)

- [ ] **Step 2: Write the failing sweep tests**

Create `test/expiry.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  env,
  runInDurableObject,
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import worker, { type Env } from '../src/index';
import { expireIdleMatches } from '../src/expiry';
import { syncLobbyIndex, upsertMatchSummary } from '../src/lobby';
import type { MatchState } from '@fortytwo/rules';

const testEnv = env as unknown as Env;
const NOW = Date.parse('2026-10-01T09:00:00.000Z');
const OLD = '2026-09-01T00:00:00.000Z'; // 30 days before NOW
const RECENT = '2026-09-30T00:00:00.000Z'; // 1 day before NOW

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}

// A match created by p1 whose DO and lobby row both say it was last touched at `updatedOn`.
async function plantMatch(id: string, updatedOn: string, overrides: Partial<MatchState> = {}) {
  const stub = stubFor(id);
  const created = await stub.create('p1', id);
  const match = { ...created, updatedOn, ...overrides };
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('match', match);
  });
  await syncLobbyIndex(testEnv.DB, match);
  return stub;
}

async function lobbyRow(id: string) {
  return testEnv.DB.prepare('SELECT status, updated_on FROM matches WHERE id = ?')
    .bind(id)
    .first<{ status: string; updated_on: string }>();
}

beforeEach(async () => {
  await testEnv.DB.batch([testEnv.DB.prepare('DELETE FROM match_players'), testEnv.DB.prepare('DELETE FROM matches')]);
});

describe('expireIdleMatches', () => {
  it('deletes an active match idle past the cutoff, in D1 and in its DO', async () => {
    const stub = await plantMatch('exp-old', OLD);

    const summary = await expireIdleMatches(testEnv, NOW);

    expect(summary).toEqual({ expired: 1, refreshed: 0, orphaned: 0, failed: 0 });
    expect(await lobbyRow('exp-old')).toBeNull();
    expect(await stub.getMatch()).toMatchObject({ ok: false, status: 404 });
  });

  it('leaves a recently-updated match alone', async () => {
    await plantMatch('exp-recent', RECENT);

    expect(await expireIdleMatches(testEnv, NOW)).toEqual({ expired: 0, refreshed: 0, orphaned: 0, failed: 0 });
    expect(await lobbyRow('exp-recent')).not.toBeNull();
  });

  it('never touches completed matches', async () => {
    const stub = await plantMatch('exp-completed', OLD, { winningTeam: 1 });

    await expireIdleMatches(testEnv, NOW);

    expect((await lobbyRow('exp-completed'))?.status).toBe('completed');
    expect((await stub.getMatch()).ok).toBe(true);
  });

  it('re-syncs a stale lobby row whose DO was updated since, instead of deleting it', async () => {
    const stub = await plantMatch('exp-stale-row', RECENT);
    await upsertMatchSummary(testEnv.DB, { id: 'exp-stale-row', status: 'active', playerCount: 1, updatedOn: OLD });

    const summary = await expireIdleMatches(testEnv, NOW);

    expect(summary.refreshed).toBe(1);
    expect((await lobbyRow('exp-stale-row'))?.updated_on).toBe(RECENT);
    expect((await stub.getMatch()).ok).toBe(true);
  });

  it('removes an orphaned lobby row whose DO holds no match', async () => {
    await upsertMatchSummary(testEnv.DB, { id: 'exp-orphan', status: 'active', playerCount: 1, updatedOn: OLD });

    expect((await expireIdleMatches(testEnv, NOW)).orphaned).toBe(1);
    expect(await lobbyRow('exp-orphan')).toBeNull();
  });

  it('keeps going past a match that fails, and tries it only once per run', async () => {
    await plantMatch('exp-fails', OLD);
    await plantMatch('exp-works', '2026-09-02T00:00:00.000Z');
    const calls: string[] = [];

    const summary = await expireIdleMatches(testEnv, NOW, async (id, cutoff) => {
      calls.push(id);
      if (id === 'exp-fails') throw new Error('boom');
      return stubFor(id).expire(cutoff);
    });

    expect(summary).toEqual({ expired: 1, refreshed: 0, orphaned: 0, failed: 1 });
    expect(calls).toEqual(['exp-fails', 'exp-works']);
    expect(await lobbyRow('exp-fails')).not.toBeNull();
  });
});

describe('scheduled handler', () => {
  it('runs the sweep', async () => {
    await plantMatch('exp-cron', OLD);
    const controller = createScheduledController({ scheduledTime: NOW, cron: '0 9 * * *' });
    const ctx = createExecutionContext();

    await worker.scheduled(controller, testEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(await lobbyRow('exp-cron')).toBeNull();
  });
});
```

Run: `npm test -w @fortytwo/worker -- test/expiry.test.ts`
Expected: FAIL - cannot resolve `../src/expiry`.

- [ ] **Step 3: Implement `MatchDO.expire`**

In `matchDO.ts`, next to `LeaveResult`:

```ts
// What the expiry sweep (expiry.ts) learns from one match: it was deleted, the lobby row that
// pointed here was stale (here's the match to re-sync it from), or there was nothing here at all.
export type ExpireOutcome = { outcome: 'expired' } | { outcome: 'missing' } | { outcome: 'fresh'; match: MatchState };
```

Method (after `leave`):

```ts
  // Deletes this match if it is still active and was last changed before `cutoff`. This DO, not
  // the D1 row that led the sweep here, decides - the row is only an index and can lag behind.
  async expire(cutoff: string): Promise<ExpireOutcome> {
    const match = await this.load();
    if (match === null) return { outcome: 'missing' };
    if (match.winningTeam !== null || match.updatedOn >= cutoff) return { outcome: 'fresh', match };
    await this.destroy();
    return { outcome: 'expired' };
  }
```

- [ ] **Step 4: Implement the sweep**

Create `src/expiry.ts`:

```ts
// The daily sweep (index.ts's `scheduled`, on wrangler.toml's cron) that deletes active matches
// nobody has touched in MATCH_IDLE_DAYS: tables that never filled and games everyone walked away
// from. D1 says which matches look idle; each match's DO has the final say (MatchDO.expire).
import type { Env } from './index';
import type { ExpireOutcome } from './matchDO';
import { deleteFromLobbyIndex, syncLobbyIndex } from './lobby';

export const MATCH_IDLE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
// Bounds one run's work; whatever is left over waits for tomorrow's.
const BATCH_SIZE = 100;
const MAX_BATCHES = 10;

export interface ExpirySummary {
  expired: number;
  refreshed: number;
  orphaned: number;
  failed: number;
}

export type ExpireOne = (matchId: string, cutoff: string) => Promise<ExpireOutcome>;

export async function expireIdleMatches(
  env: Env,
  now: number,
  expireOne: ExpireOne = (matchId, cutoff) => env.MATCH_DO.get(env.MATCH_DO.idFromName(matchId)).expire(cutoff)
): Promise<ExpirySummary> {
  // updated_on holds ISO-8601 UTC strings, so comparing strings compares times.
  const cutoff = new Date(now - MATCH_IDLE_DAYS * DAY_MS).toISOString();
  const summary: ExpirySummary = { expired: 0, refreshed: 0, orphaned: 0, failed: 0 };
  // A match that failed keeps its row, which would match the next batch's query again - so every
  // id already tried this run is excluded, as one JSON param (D1 caps bound parameters at 100).
  const tried: string[] = [];

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const { results } = await env.DB.prepare(
      `SELECT id FROM matches
       WHERE status = 'active' AND updated_on < ? AND id NOT IN (SELECT value FROM json_each(?))
       ORDER BY updated_on LIMIT ?`
    )
      .bind(cutoff, JSON.stringify(tried), BATCH_SIZE)
      .all<{ id: string }>();
    if (results.length === 0) break;

    for (const { id } of results) {
      tried.push(id);
      try {
        const result = await expireOne(id, cutoff);
        if (result.outcome === 'fresh') {
          await syncLobbyIndex(env.DB, result.match);
          summary.refreshed++;
        } else {
          await deleteFromLobbyIndex(env.DB, id);
          summary[result.outcome === 'expired' ? 'expired' : 'orphaned']++;
        }
      } catch (error) {
        console.error(`Failed to expire match ${id}`, error);
        summary.failed++;
      }
    }
  }

  console.log('Match expiry sweep', summary);
  return summary;
}
```

- [ ] **Step 5: Wire the cron**

`index.ts` - add `import { expireIdleMatches } from './expiry';` and replace the final `export default app;` with:

```ts
export { app };

// The Worker's entry points: every request goes through the Hono app; the daily cron
// (wrangler.toml's [triggers]) runs the expiry sweep.
export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx) {
    ctx.waitUntil(expireIdleMatches(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
```

`wrangler.toml` - after the `[assets]` block, add:

```toml
# Daily at 09:00 UTC: delete active matches idle for 14 days (src/expiry.ts).
[triggers]
crons = ["0 9 * * *"]
```

`test/routes.matches.test.ts:5` - change `import app, { type Env } from '../src/index';` to `import { app, type Env } from '../src/index';`.

- [ ] **Step 6: Run the worker suite and typecheck**

Run: `npm test -w @fortytwo/worker` → PASS.
Run: `npx tsc --noEmit -p apps/worker` → no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/migrations/0004_matches_status_updated.sql apps/worker/src/expiry.ts apps/worker/src/matchDO.ts apps/worker/src/index.ts apps/worker/wrangler.toml apps/worker/test/expiry.test.ts apps/worker/test/routes.matches.test.ts
git commit -m "Delete active matches idle for 14 days with a daily cron sweep (#18)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Worker - paged lobby lists

**Files:**
- Modify: `cloudflare/packages/api-types/src/index.ts`
- Create: `cloudflare/apps/worker/src/cursor.ts`
- Create: `cloudflare/apps/worker/test/cursor.test.ts`
- Modify: `cloudflare/apps/worker/src/lobby.ts` (`listActive`, `listCompleted`, `listJoinable`)
- Modify: `cloudflare/apps/worker/src/routes/matches.ts` (`matches.get('/')`)
- Modify: `cloudflare/apps/worker/test/lobby.test.ts`, `cloudflare/apps/worker/test/routes.matches.test.ts`

**Interfaces:**
- Produces:
  - api-types: `export interface MatchPage { matches: MatchSummary[]; nextCursor: string | null }`
  - lobby.ts: `export const LOBBY_PAGE_SIZE = 20;`, `export interface LobbyCursor { updatedOn: string; id: string }`, `export interface LobbyPage { rows: MatchIndexRow[]; next: LobbyCursor | null }`; `listActive/listCompleted/listJoinable(db, userId, cursor?: LobbyCursor | null): Promise<LobbyPage>`
  - cursor.ts: `encodeCursor(cursor: LobbyCursor): string`, `decodeCursor(raw: string | undefined): LobbyCursor | null` (throws `BadRequestError('Invalid cursor')`)
  - `GET /api/matches?filter=&cursor=` → `MatchPage`

- [ ] **Step 1: Cursor tests**

Create `test/cursor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decodeCursor, encodeCursor } from '../src/cursor';
import { BadRequestError } from '../src/requestBody';

describe('lobby cursor', () => {
  it('round-trips', () => {
    const cursor = { updatedOn: '2026-09-24T01:00:00.000Z', id: '0b7c1f2e-aaaa-bbbb-cccc-123456789abc' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('is URL-safe', () => {
    expect(encodeCursor({ updatedOn: '2026-09-24T01:00:00.000Z', id: '???>>>' })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('treats a missing or empty cursor as the first page', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it.each(['%%%', btoa('no-separator'), btoa('not-a-date|id'), btoa('2026-09-24T01:00:00.000Z|')])(
    'rejects %s',
    (raw) => {
      expect(() => decodeCursor(raw)).toThrow(BadRequestError);
    }
  );
});
```

Run: `npm test -w @fortytwo/worker -- test/cursor.test.ts` → FAIL (no module).

- [ ] **Step 2: Implement `cursor.ts` and the types**

In `lobby.ts`, add near `MatchIndexRow`:

```ts
// Lobby lists come one page at a time, newest first. A page ends at its last row's
// (updatedOn, id); the next page starts strictly after it.
export const LOBBY_PAGE_SIZE = 20;

export interface LobbyCursor {
  updatedOn: string;
  id: string;
}

export interface LobbyPage {
  rows: MatchIndexRow[];
  next: LobbyCursor | null;
}
```

Create `src/cursor.ts`:

```ts
// The lobby's page cursor as clients see it: an opaque, URL-safe token for where the last page
// ended (lobby.ts's LobbyCursor), so clients never build or depend on its contents.
import type { LobbyCursor } from './lobby';
import { BadRequestError } from './requestBody';

export function encodeCursor({ updatedOn, id }: LobbyCursor): string {
  return btoa(`${updatedOn}|${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// No cursor means the first page. Anything that isn't one of ours is a 400.
export function decodeCursor(raw: string | undefined): LobbyCursor | null {
  if (raw === undefined || raw === '') return null;
  let text: string;
  try {
    text = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    throw new BadRequestError('Invalid cursor');
  }
  const separator = text.indexOf('|');
  const updatedOn = text.slice(0, separator);
  const id = text.slice(separator + 1);
  if (separator <= 0 || id === '' || Number.isNaN(Date.parse(updatedOn))) {
    throw new BadRequestError('Invalid cursor');
  }
  return { updatedOn, id };
}
```

In `packages/api-types/src/index.ts`, after `MatchSummary`:

```ts
// One page of a lobby list (GET /api/matches). `nextCursor` goes back as `?cursor=` for the next
// page; null on the last one.
export interface MatchPage {
  matches: MatchSummary[];
  nextCursor: string | null;
}
```

Run cursor tests → PASS.

- [ ] **Step 3: Write failing paging tests in `lobby.test.ts`**

Update every existing `listActive(...)` / `listCompleted(...)` / `listJoinable(...)` call in `test/lobby.test.ts` to read `.rows`, e.g. `const results = (await listActive(testEnv.DB, 'p1')).rows;`. Add `LOBBY_PAGE_SIZE` to the `../src/lobby` import. Then append inside `describe('lobby', ...)`:

```ts
  describe('paging', () => {
    // `count` active matches p1 is in, one minute apart, newest last.
    async function seedActive(count: number, updatedOn = (i: number) => `2026-09-24T01:${String(i).padStart(2, '0')}:00Z`) {
      for (let i = 0; i < count; i++) {
        const id = `m-${String(i).padStart(2, '0')}`;
        await upsertMatchSummary(testEnv.DB, { id, status: 'active', playerCount: 2, updatedOn: updatedOn(i) });
        await syncMatchPlayers(testEnv.DB, id, seat('p1', 'p2'));
      }
    }

    it('returns a full page and a cursor, then the rest with no cursor', async () => {
      await seedActive(LOBBY_PAGE_SIZE + 1);

      const first = await listActive(testEnv.DB, 'p1');
      expect(first.rows).toHaveLength(LOBBY_PAGE_SIZE);
      expect(first.rows[0].id).toBe('m-20');
      expect(first.next).toEqual({ updatedOn: first.rows[19].updatedOn, id: first.rows[19].id });

      const second = await listActive(testEnv.DB, 'p1', first.next);
      expect(second.rows.map((r) => r.id)).toEqual(['m-00']);
      expect(second.next).toBeNull();
    });

    it('has no cursor when everything fits on one page', async () => {
      await seedActive(LOBBY_PAGE_SIZE);
      expect((await listActive(testEnv.DB, 'p1')).next).toBeNull();
    });

    it('pages through matches sharing one updated_on by id, without skipping or repeating any', async () => {
      await seedActive(LOBBY_PAGE_SIZE + 5, () => '2026-09-24T01:00:00Z');

      const first = await listActive(testEnv.DB, 'p1');
      const second = await listActive(testEnv.DB, 'p1', first.next);
      const ids = [...first.rows, ...second.rows].map((r) => r.id);

      expect(new Set(ids).size).toBe(LOBBY_PAGE_SIZE + 5);
      expect(ids).toEqual([...ids].sort().reverse());
    });

    it('pages Joinable and Completed the same way', async () => {
      for (let i = 0; i <= LOBBY_PAGE_SIZE; i++) {
        const id = `j-${String(i).padStart(2, '0')}`;
        await upsertMatchSummary(testEnv.DB, { id, status: 'active', playerCount: 1, updatedOn: `2026-09-24T02:${String(i).padStart(2, '0')}:00Z` });
        await syncMatchPlayers(testEnv.DB, id, seat('p2'));
        const done = `c-${String(i).padStart(2, '0')}`;
        await upsertMatchSummary(testEnv.DB, { id: done, status: 'completed', playerCount: 4, updatedOn: `2026-09-24T03:${String(i).padStart(2, '0')}:00Z` });
        await syncMatchPlayers(testEnv.DB, done, seat('p1', 'p2', 'p3', 'p4'));
      }

      const joinable = await listJoinable(testEnv.DB, 'p1');
      expect(joinable.rows).toHaveLength(LOBBY_PAGE_SIZE);
      expect((await listJoinable(testEnv.DB, 'p1', joinable.next)).rows.map((r) => r.id)).toEqual(['j-00']);

      const completed = await listCompleted(testEnv.DB, 'p1');
      expect(completed.rows).toHaveLength(LOBBY_PAGE_SIZE);
      expect((await listCompleted(testEnv.DB, 'p1', completed.next)).rows.map((r) => r.id)).toEqual(['c-00']);
    });
  });
```

Run: `npm test -w @fortytwo/worker -- test/lobby.test.ts` → FAIL (`.rows` undefined).

- [ ] **Step 4: Implement paged queries**

Replace `listActive`, `listCompleted`, `listJoinable` in `lobby.ts` with:

```ts
// One more row than a page is fetched; if it comes back, there's another page after this one.
function toPage(results: MatchIndexRow[]): LobbyPage {
  const rows = results.slice(0, LOBBY_PAGE_SIZE);
  const last = rows[rows.length - 1];
  const next = results.length > LOBBY_PAGE_SIZE ? { updatedOn: last.updatedOn, id: last.id } : null;
  return { rows, next };
}

// Matches the user is seated in with the given status, a page at a time.
//
// NOTE: D1's `.all<MatchIndexRow>()` type parameter is compile-time only - it does not rename
// runtime columns. The underlying `matches` table is snake_case (player_count, updated_on), so
// every column that maps to a camelCase MatchIndexRow field must be explicitly aliased with AS,
// or `.playerCount`/`.updatedOn` would be undefined on every returned row at runtime.
async function listForPlayer(
  db: D1Database,
  userId: string,
  status: 'active' | 'completed',
  cursor: LobbyCursor | null
): Promise<LobbyPage> {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.status, m.player_count AS playerCount, m.updated_on AS updatedOn
       FROM matches m JOIN match_players mp ON mp.match_id = m.id
       WHERE mp.player_id = ?1 AND m.status = ?2
       AND (?3 IS NULL OR (m.updated_on, m.id) < (?3, ?4))
       ORDER BY m.updated_on DESC, m.id DESC LIMIT ?5`
    )
    .bind(userId, status, cursor?.updatedOn ?? null, cursor?.id ?? null, LOBBY_PAGE_SIZE + 1)
    .all<MatchIndexRow>();
  return toPage(results);
}

export function listActive(db: D1Database, userId: string, cursor: LobbyCursor | null = null): Promise<LobbyPage> {
  return listForPlayer(db, userId, 'active', cursor);
}

export function listCompleted(db: D1Database, userId: string, cursor: LobbyCursor | null = null): Promise<LobbyPage> {
  return listForPlayer(db, userId, 'completed', cursor);
}

export async function listJoinable(db: D1Database, userId: string, cursor: LobbyCursor | null = null): Promise<LobbyPage> {
  const { results } = await db
    .prepare(
      `SELECT id, status, player_count AS playerCount, updated_on AS updatedOn
       FROM matches WHERE status = 'active' AND player_count < 4
       AND id NOT IN (SELECT match_id FROM match_players WHERE player_id = ?1)
       AND (?2 IS NULL OR (updated_on, id) < (?2, ?3))
       ORDER BY updated_on DESC, id DESC LIMIT ?4`
    )
    .bind(userId, cursor?.updatedOn ?? null, cursor?.id ?? null, LOBBY_PAGE_SIZE + 1)
    .all<MatchIndexRow>();
  return toPage(results);
}
```

Run: `npm test -w @fortytwo/worker -- test/lobby.test.ts` → PASS.

- [ ] **Step 5: Failing route tests**

In `test/routes.matches.test.ts`, every `GET /api/matches?filter=...` response is now a `MatchPage`. Update the three existing reads:
- line ~105: `const joinable = ((await joinableRes.json()) as { matches: { id: string; teams: string[][] }[] }).matches;`
- line ~302: `const rows = ((await res.json()) as { matches: { id: string; teams: string[][] }[] }).matches;`
- line ~325: `const rows = ((await res.json()) as { matches: { id: string; seats: (string | null)[] }[] }).matches;`

Then add inside `describe('match routes', ...)`:

```ts
  describe('GET /api/matches paging', () => {
    it('returns a page with a cursor that fetches the next page', async () => {
      const p1 = await signToken('p1');
      for (let i = 0; i < 21; i++) await api('/api/matches', p1, { method: 'POST' });

      const first = (await (await api('/api/matches?filter=Active', p1)).json()) as { matches: { id: string }[]; nextCursor: string | null };
      expect(first.matches).toHaveLength(20);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = (await (await api(`/api/matches?filter=Active&cursor=${first.nextCursor}`, p1)).json()) as typeof first;
      expect(second.matches).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect(first.matches.map((m) => m.id)).not.toContain(second.matches[0].id);
    });

    it('rejects a malformed cursor with a 400', async () => {
      const res = await api('/api/matches?filter=Active&cursor=%25%25', await signToken('p1'));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ title: 'Invalid request', detail: 'Invalid cursor' });
    });
  });
```

Run: `npm test -w @fortytwo/worker -- test/routes.matches.test.ts` → FAIL.

- [ ] **Step 6: Implement the route**

In `routes/matches.ts`: add `import { decodeCursor, encodeCursor } from '../cursor';`, change the api-types import to `import type { MatchPage, MatchSummary } from '@fortytwo/api-types';`, and replace `matches.get('/', ...)`'s opening through the `return c.json(` with:

```ts
matches.get('/', async (c) => {
  const userId = c.get('user').sub;
  const filter = c.req.query('filter') ?? 'Active';
  const cursor = decodeCursor(c.req.query('cursor'));
  const list = filter === 'Completed' ? listCompleted : filter === 'Joinable' ? listJoinable : listActive;
  const { rows, next } = await list(c.env.DB, userId, cursor);
  const playersByMatch = await listMatchPlayers(c.env.DB, rows.map((row) => row.id));
  const allPlayerIds = [...playersByMatch.values()].flat().map((p) => p.playerId);
  const names = await displayNames(c.env, [...new Set(allPlayerIds)]);
  const summaries = rows.map((row): MatchSummary => {
    const seated = playersByMatch.get(row.id) ?? [];
    const nameOf = (playerId: string) => names.get(playerId) ?? playerId;
    const namesOn = (team: Teams) => seated.filter((p) => p.team === team).map((p) => nameOf(p.playerId));
    const seats = [0, 1, 2, 3].map((position) => {
      const player = seated.find((p) => p.position === position);
      return player ? nameOf(player.playerId) : null;
    });
    return { ...row, teams: [namesOn(Teams.TeamA), namesOn(Teams.TeamB)], seats };
  });
  return c.json({ matches: summaries, nextCursor: next && encodeCursor(next) } satisfies MatchPage);
});
```

- [ ] **Step 7: Run worker suite + typecheck**

Run: `npm test -w @fortytwo/worker` → PASS. Run: `npx tsc --noEmit -p apps/worker` → clean.

- [ ] **Step 8: Commit**

```bash
git add packages/api-types/src/index.ts apps/worker/src/cursor.ts apps/worker/src/lobby.ts apps/worker/src/routes/matches.ts apps/worker/test/cursor.test.ts apps/worker/test/lobby.test.ts apps/worker/test/routes.matches.test.ts
git commit -m "Page the lobby lists 20 at a time with a keyset cursor (#18)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Web - Lobby "Load more"

**Files:**
- Modify: `cloudflare/apps/web/src/api/client.ts`
- Modify: `cloudflare/apps/web/src/pages/Lobby.tsx`, `Lobby.css`, `Lobby.test.tsx`

**Interfaces:**
- Consumes: `MatchPage` (Task 4), `GET /api/matches?filter=&cursor=`
- Produces: `client.listMatches(filter, cursor?: string): Promise<MatchPage>`; `export type { MatchPage }` from `client.ts`

- [ ] **Step 1: Update the client**

In `client.ts`: add `MatchPage` to the `@fortytwo/api-types` import and to the `export type { ... }` line; replace `listMatches` with:

```ts
    // One page of a lobby list; pass the previous page's `nextCursor` for the next one.
    listMatches: (filter: 'Active' | 'Completed' | 'Joinable', cursor?: string): Promise<MatchPage> =>
      request<MatchPage>(
        getToken,
        `/api/matches?filter=${filter}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      ),
```

- [ ] **Step 2: Update existing Lobby tests to the new shape, add failing ones**

In `Lobby.test.tsx`:
- import `MatchPage` alongside `MatchSummary` from `'../api/client'`;
- in `mockLists`, wrap each fixture: `return Promise.resolve(page(ACTIVE_FIXTURE));` etc., with helper `const page = (matches: MatchSummary[], nextCursor: string | null = null): MatchPage => ({ matches, nextCursor });`;
- any other `listMatchesMock.mockResolvedValue(X)` / `mockImplementation` returning an array → wrap with `page(...)`;
- every `toHaveBeenCalledWith('Active')`-style assertion on `listMatchesMock` gains a second `undefined` argument (`toHaveBeenLastCalledWith('Active', undefined)`) - React Query passes `pageParam`.

Then add:

```ts
  describe('paging', () => {
    const SECOND: MatchSummary = { ...ACTIVE_FIXTURE[0], id: 'active-2', teams: [['Erin'], ['Finn']], seats: ['Erin', 'Finn', null, null] };

    beforeEach(() => {
      listMatchesMock.mockImplementation((_filter: string, cursor?: string) =>
        // Page 2 repeats active-1, as if it was updated (and moved up) between the two loads.
        Promise.resolve(cursor === undefined ? page(ACTIVE_FIXTURE, 'c1') : page([ACTIVE_FIXTURE[0], SECOND]))
      );
    });

    it('appends the next page on Load more, shows a repeated match once, and hides the button at the end', async () => {
      renderLobby();
      await screen.findByText(ACTIVE_ROW);

      fireEvent.click(screen.getByRole('button', { name: /load more/i }));

      await screen.findByText('Erin vs Finn');
      expect(listMatchesMock).toHaveBeenLastCalledWith('Active', 'c1');
      expect(screen.getAllByText(ACTIVE_ROW)).toHaveLength(1);
      expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
    });

    it('shows no Load more when the first page is the last', async () => {
      mockLists();
      renderLobby();
      await screen.findByText(ACTIVE_ROW);
      expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
    });

    it('refreshes only the first page', async () => {
      renderLobby();
      await screen.findByText(ACTIVE_ROW);
      fireEvent.click(screen.getByRole('button', { name: /load more/i }));
      await screen.findByText('Erin vs Finn');
      expect(listMatchesMock).toHaveBeenCalledTimes(2);

      fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

      await waitFor(() => expect(listMatchesMock).toHaveBeenCalledTimes(3));
      expect(listMatchesMock).toHaveBeenLastCalledWith('Active', undefined);
      await waitFor(() => expect(screen.queryByText('Erin vs Finn')).toBeNull());
      expect(screen.getByText(ACTIVE_ROW)).toBeTruthy();
    });
  });
```

Run: `npm test -w @fortytwo/web -- src/pages/Lobby.test.tsx` → FAIL.

- [ ] **Step 3: Implement in `Lobby.tsx`**

Imports: `useInfiniteQuery, useMutation, useQueryClient, type InfiniteData` from `@tanstack/react-query` (drop `useQuery`); `type MatchPage` from `'../api/client'`.

Add above `Lobby`:

```ts
// Every loaded page's rows in order, each match once: a match updated between page loads moves
// to the top, so it can come back on a later page too.
function uniqueMatches(pages: MatchPage[] | undefined): MatchSummary[] | undefined {
  if (pages === undefined) return undefined;
  const seen = new Set<string>();
  return pages
    .flatMap((p) => p.matches)
    .filter((match) => {
      if (seen.has(match.id)) return false;
      seen.add(match.id);
      return true;
    });
}
```

Replace the `matchesQuery` / `matches` block with:

```ts
  const matchesQuery = useInfiniteQuery({
    queryKey: ['matches', activeTab] as const,
    queryFn: ({ pageParam }) => client.listMatches(activeTab, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const matches = uniqueMatches(matchesQuery.data?.pages);
  // "Load more" fetches too, but only a refresh spins the refresh icon.
  const refreshing = matchesQuery.isFetching && !matchesQuery.isFetchingNextPage;

  // Back to the first page: drop the rest from the cache, then refetch what's left - one request,
  // with the list kept on screen meanwhile.
  function refresh() {
    queryClient.setQueryData<InfiniteData<MatchPage, string | undefined>>(['matches', activeTab], (data) =>
      data && { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
    );
    void matchesQuery.refetch();
  }
```

In the refresh button: `disabled={refreshing}`, `onClick={refresh}`, and the icon class uses `refreshing` in place of `matchesQuery.isFetching`. After the closing `</ul>` (still inside the `matches.length > 0` branch's parent `section`), add:

```tsx
        {matchesQuery.hasNextPage && (
          <button
            type="button"
            className="action-button action-button-small lobby-load-more"
            disabled={matchesQuery.isFetchingNextPage}
            onClick={() => void matchesQuery.fetchNextPage()}
          >
            {matchesQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
```

Also update the file's header comment: "Only the selected tab's list is ever fetched - one page at a time (20), with Load more for the next."

`Lobby.css` - append:

```css
.lobby-load-more {
  display: block;
  margin: 0.75rem auto 0;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -w @fortytwo/web -- src/pages/Lobby.test.tsx` → PASS.
Run: `npm run build -w @fortytwo/web` → succeeds (runs `tsc -b`).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/pages/Lobby.tsx apps/web/src/pages/Lobby.css apps/web/src/pages/Lobby.test.tsx
git commit -m "Load lobby lists a page at a time with Load more (#18)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web - leave/cancel from the Match page; handle a deleted or missing match

**Files:**
- Modify: `cloudflare/apps/web/src/api/client.ts`
- Modify: `cloudflare/apps/web/src/api/useMatchSocket.ts`, `useMatchSocket.test.ts`
- Modify: `cloudflare/apps/web/src/pages/Match.tsx`, `Match.test.tsx`

**Interfaces:**
- Consumes: `DELETE /api/matches/:id/players` (Task 2), close code `4404`, `hasBeenDealt`/`isBot` from `@fortytwo/rules` (Task 1)
- Produces: `client.leaveMatch(id: string): Promise<void>`; `useMatchSocket(...)` returns `{ match, connected, reconnecting, deleted: boolean }`

- [ ] **Step 1: Failing socket hook test**

Append inside `describe('useMatchSocket', ...)` in `useMatchSocket.test.ts`:

```ts
  it('stops reconnecting and reports the match deleted when the server closes with 4404', async () => {
    const getToken = vi.fn(async () => 'test-token');
    const { result, unmount } = renderHook(() => useMatchSocket('match-1', getToken));
    await flush();
    await act(async () => {
      MockWebSocket.instances[0].emit('open');
    });
    expect(result.current.deleted).toBe(false);

    await act(async () => {
      MockWebSocket.instances[0].emit('close', { wasClean: true, code: 4404 });
    });
    await flush(60_000);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(result.current.deleted).toBe(true);
    unmount();
  });
```

Run: `npm test -w @fortytwo/web -- src/api/useMatchSocket.test.ts` → FAIL.

- [ ] **Step 2: Implement in `useMatchSocket.ts`**

Replace the `NO_RECONNECT_CODES` block with:

```ts
// The Worker closes every socket with this when their match is deleted (MatchDO's
// MATCH_DELETED_CLOSE_CODE): the last human left, or it expired.
export const MATCH_DELETED_CLOSE_CODE = 4404;

// Close codes the server sends on purpose to say "don't come back". Every other close - clean or
// not - is retried: a DO restart, a Worker deploy, and webSocketClose echoing a 1000 all close
// cleanly without meaning the match is over.
const NO_RECONNECT_CODES: ReadonlySet<number> = new Set([MATCH_DELETED_CLOSE_CODE]);
```

Return type gains `deleted: boolean`. Add state next to `droppedFrom`:

```ts
  // Set when the server says this match was deleted - nothing more will ever arrive for it.
  const [deletedId, setDeletedId] = useState<string | null>(null);
```

In the close listener, before `if (NO_RECONNECT_CODES.has(event.code)) return;`:

```ts
        if (event.code === MATCH_DELETED_CLOSE_CODE) setDeletedId(matchId);
```

In the effect cleanup, add `setDeletedId(null);`. In the return object, add `deleted: deletedId === matchId,`.

Run the hook tests → PASS.

- [ ] **Step 3: Client `leaveMatch`**

In `client.ts`, after `joinMatch`:

```ts
    // Leaves a match before its first deal; the last human out deletes it. The reply is the match
    // (someone's still seated) or empty (deleted) - the caller navigates away either way.
    leaveMatch: (id: string): Promise<void> =>
      request<void>(getToken, `/api/matches/${id}/players`, { method: 'DELETE' }, false),
```

- [ ] **Step 4: Failing Match page tests**

In `Match.test.tsx`: add `leaveMatchMock: vi.fn(),` to the `vi.hoisted` block (and destructure it), and `leaveMatch: leaveMatchMock,` to the mocked `apiClient`. Inside `describe('open seats', ...)` add:

```ts
    describe('leaving', () => {
      let confirmSpy: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        leaveMatchMock.mockResolvedValue(undefined);
      });
      afterEach(() => confirmSpy.mockRestore());

      it('leaves the table and goes back to the lobby', async () => {
        useMatchSocketMock.mockReturnValue({ match: waitingMatch(), connected: true });
        renderMatch();

        fireEvent.click(screen.getByRole('button', { name: 'Leave table' }));

        expect(confirmSpy).toHaveBeenCalledWith('Leave this table?');
        await waitFor(() => expect(leaveMatchMock).toHaveBeenCalledWith('match-1'));
        await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/'));
      });

      it('offers Cancel match when no other human is seated', async () => {
        const withBot = waitingMatch();
        withBot.players = [PLAYERS[0], { playerId: 'bot-1', position: Positions.Third, ready: true }];
        useMatchSocketMock.mockReturnValue({ match: withBot, connected: true });
        renderMatch();

        fireEvent.click(screen.getByRole('button', { name: 'Cancel match' }));

        expect(confirmSpy).toHaveBeenCalledWith('Cancel this match? It will be deleted.');
        await waitFor(() => expect(leaveMatchMock).toHaveBeenCalled());
      });

      it('does nothing when the confirm is dismissed', () => {
        confirmSpy.mockReturnValue(false);
        useMatchSocketMock.mockReturnValue({ match: waitingMatch(), connected: true });
        renderMatch();

        fireEvent.click(screen.getByRole('button', { name: 'Leave table' }));

        expect(leaveMatchMock).not.toHaveBeenCalled();
      });

      it('is not offered once the hand is dealt', () => {
        useMatchSocketMock.mockReturnValue({ match: baseMatch(), connected: true });
        renderMatch();
        expect(screen.queryByRole('button', { name: /leave table|cancel match/i })).toBeNull();
      });

      it('does not announce the deletion to the player whose own leave caused it', async () => {
        useMatchSocketMock.mockReturnValue({ match: waitingMatch(), connected: true });
        renderMatch();
        // From the next render on, the socket reports the deletion - as it would once the leave
        // lands and the DO closes every socket, this player's included.
        useMatchSocketMock.mockReturnValue({ match: waitingMatch(), connected: false, deleted: true });

        fireEvent.click(screen.getByRole('button', { name: 'Leave table' }));

        await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/'));
        expect(toastInfoMock).not.toHaveBeenCalledWith('This match was deleted');
      });
    });
```


And at the top level of `describe('Match', ...)`:

```ts
  it('sends everyone back to the lobby when the match is deleted under them', async () => {
    useMatchSocketMock.mockReturnValue({ match: null, connected: false, deleted: true });
    renderMatch();

    await waitFor(() => expect(toastInfoMock).toHaveBeenCalledWith('This match was deleted'));
    expect(navigateMock).toHaveBeenCalledWith('/', { replace: true });
  });

  it('shows why a match failed to load, instead of spinning forever', async () => {
    getMatchMock.mockRejectedValue(new Error('Match not found!'));
    useMatchSocketMock.mockReturnValue({ match: null, connected: false });
    renderMatch();

    expect(await screen.findByRole('alert')).toHaveTextContent('Match not found!');
    expect(screen.getByRole('link', { name: /back to lobby/i }).getAttribute('href')).toBe('/');
  });
```

(If `toHaveTextContent` isn't available - check for `@testing-library/jest-dom` in the web vitest setup - use `expect((await screen.findByRole('alert')).textContent).toContain('Match not found!')`.)

Run: `npm test -w @fortytwo/web -- src/pages/Match.test.tsx` → FAIL.

- [ ] **Step 5: Implement in `Match.tsx`**

Imports: add `useQueryClient` to the `@tanstack/react-query` import; add `hasBeenDealt` and `isBot` to the `@fortytwo/rules` value import list.

Change the socket destructure to include `deleted` (wherever `useMatchSocket(` is called: `const { match: socketMatch, connected, reconnecting, deleted } = useMatchSocket(...)`).

After `addBotsMutation`, add:

```ts
  const queryClient = useQueryClient();
  // Set (by the button, before the request goes out) while this player's own leave is in flight:
  // if it deletes the match, their socket gets the same "deleted" close as everyone else's, and
  // they shouldn't be told about it.
  const leavingRef = useRef(false);
  const leaveMutation = useMutation({
    mutationFn: () => client.leaveMatch(matchId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['matches'] });
      navigate('/');
    },
    onError: (error) => {
      leavingRef.current = false;
      toastError(error);
    },
  });

  // The match was deleted (its last human left, or it expired) - there's nothing left to show.
  useEffect(() => {
    if (!deleted || leavingRef.current) return;
    toastInfo('This match was deleted');
    void queryClient.invalidateQueries({ queryKey: ['matches'] });
    navigate('/', { replace: true });
  }, [deleted, navigate, queryClient]);
```

(`navigate` is declared a few lines above `addBotsMutation` - keep these after it.)

Before the `if (!match || !myPlayerId)` spinner guard:

```tsx
  // A match that can't be loaded - most often one that was deleted - says so rather than leaving
  // the loading spinner up forever.
  if (!match && matchQuery.isError) {
    return (
      <div role="alert" className="match-error">
        <p>{matchQuery.error.message}</p>
        <Link to="/">Back to lobby</Link>
      </div>
    );
  }
```

In `.table-waiting`, after the "Fill with bots" button:

```tsx
                    {!hasBeenDealt(match) && (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        disabled={leaveMutation.isPending}
                        onClick={() => {
                          if (window.confirm(onlyHumanSeated ? 'Cancel this match? It will be deleted.' : 'Leave this table?')) {
                            leavingRef.current = true;
                            leaveMutation.mutate();
                          }
                        }}
                      >
                        {onlyHumanSeated ? 'Cancel match' : 'Leave table'}
                      </button>
                    )}
```

with, near `isTableReady` (after the early returns, where `match` is non-null):

```ts
  // Leaving deletes the match when nobody else human is seated, so the button says so.
  const onlyHumanSeated = match.players.every((p) => p.playerId === myPlayerId || isBot(p.playerId));
```

- [ ] **Step 6: Run web suite + build**

Run: `npm test -w @fortytwo/web` → PASS.
Run: `npm run build -w @fortytwo/web` → succeeds.
Run: `npm run lint -w @fortytwo/web` → no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/api/useMatchSocket.ts apps/web/src/api/useMatchSocket.test.ts apps/web/src/pages/Match.tsx apps/web/src/pages/Match.test.tsx
git commit -m "Leave or cancel a match from the table; handle deleted and missing matches (#18)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Full verification

- [ ] **Step 1:** From `cloudflare/`: `npm test -w @fortytwo/rules && npm test -w @fortytwo/worker && npm test -w @fortytwo/web` → all PASS.
- [ ] **Step 2:** `npx tsc --noEmit -p apps/worker` and `npm run build -w @fortytwo/web` → clean.
- [ ] **Step 3:** `npx wrangler deploy --dry-run -c apps/worker/wrangler.toml --outdir /tmp/ft-dry` (from `cloudflare/`) → bundles, and the output lists the `0 9 * * *` schedule. Delete the outdir afterwards.
- [ ] **Step 4:** Deployment note for the PR description: run `wrangler d1 migrations apply fortytwo --remote` for `0004` before (or with) deploying.
