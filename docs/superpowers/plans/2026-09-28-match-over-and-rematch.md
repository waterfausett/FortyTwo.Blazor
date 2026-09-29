# Match Over, Rematch, and New-Hand Cue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a match ends, show a summary dialog with Back to lobby and an everyone-opts-in Rematch that keeps all four seats; toast when a new hand is dealt.

**Architecture:** Pure rules functions (`voteRematch`, `rematchAgreed`, `createRematch`) in `packages/rules`. The old match's Durable Object records votes and, once everyone has agreed, creates the new match's DO *before* saving/broadcasting the `rematchId`, so clients that navigate on the broadcast never hit a missing match. The web page renders a `MatchSummary` dialog from the `MatchState` it already has and follows `rematchId`.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers + Durable Objects + D1 (`@cloudflare/vitest-pool-workers`), Hono, React 19, React Router 7, TanStack Query, SweetAlert2.

**Spec:** `docs/superpowers/specs/2026-09-28-match-over-and-rematch-design.md`

## Global Constraints

- All paths below are relative to `cloudflare/`. Run tests per package: `npm test` in `packages/rules`, `apps/worker`, or `apps/web` (each is `vitest run`). Web also: `npm run lint` and `npm run build` (runs `tsc -b`).
- `MatchState.rematchVotes` and `MatchState.rematchId` are **optional** — matches already stored in DO storage lack them.
- Bots (`bot-1`, `bot-2`, `bot-3`) count as having agreed to a rematch; they never vote.
- A rematch is created only once every seated player has agreed. No vote withdrawal, no timeout.
- The web route is `/match/:matchId` (singular `match`).
- Match these repo conventions: comments explain *why*, in the voice of the surrounding code; commits are `Area: sentence-case summary` (e.g. `Rules: ...`, `Worker: ...`, `Match: ...`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Two votes racing the last seat** — two players' final votes arrive together; exactly one rematch match must exist and both must see the same `rematchId`. (Task 2: repeat-vote test asserts the same id and an untouched deal.)
2. **Clients navigating before the rematch exists** — the broadcast carrying `rematchId` must never precede the new DO's creation. (Task 2: after the completing vote returns, the new DO already answers `getMatch` with 200.)
3. **Old stored matches without the new fields** — `rematchVotes`/`rematchId` undefined must not crash the vote or the web summary. (Task 1: vote on a match with neither field; Task 4: summary counts with `rematchVotes` absent.)
4. **The page remounting into the rematch** — hold/sweep/turn state and the new-hand toast tracker must not carry over from the old match. (Task 3: `MatchRoute` keys `Match` by id; Task 5: arriving at a match never toasts on first render.)
5. **Unseated users and unfinished matches** — a spectator or a mid-match vote must be rejected with a 400, not create anything. (Task 1 and Task 2 tests.)

---

### Task 1: Rules — rematch votes and rematch creation

**Files:**
- Create: `packages/rules/src/botIds.ts`
- Modify: `packages/rules/src/matchEngine.ts` (MatchState, new functions at the end of the mutating functions)
- Modify: `packages/rules/src/index.ts`
- Modify: `apps/worker/src/bots.ts:18-22` (re-export instead of defining)
- Test: `packages/rules/src/matchEngine.test.ts`

**Interfaces:**
- Produces:
  - `BOT_IDS: readonly ['bot-1','bot-2','bot-3']`, `isBot(playerId: string): boolean` (exported from `@fortytwo/rules`)
  - `MatchState.rematchVotes?: string[]`, `MatchState.rematchId?: string`
  - `voteRematch(match: MatchState, playerId: string): MatchState`
  - `rematchAgreed(match: MatchState): string[]` — player ids that count as agreeing (voters + bots), in seat order
  - `createRematch(id: string, previous: MatchState, dealOrder: Domino[]): MatchState`

- [ ] **Step 1: Move bot ids into the rules package**

Create `packages/rules/src/botIds.ts`:

```ts
// The reserved ids the Worker's dev-only bots sit under (apps/worker/src/bots.ts). Lives here, not
// in the Worker, because the rules and the web client need to know who's a bot too: bots count as
// agreeing to a rematch without voting.
export const BOT_IDS = ['bot-1', 'bot-2', 'bot-3'] as const;

export function isBot(playerId: string): boolean {
  return (BOT_IDS as readonly string[]).includes(playerId);
}
```

In `apps/worker/src/bots.ts`, add `BOT_IDS` and `isBot` to the existing `import { ... } from '@fortytwo/rules'` block at the top, and replace lines 18-22 (the `BOT_IDS` const and `isBot` function) with:

```ts
// Defined in the rules package so the web client can tell bots apart too; re-exported here for
// the Worker code that already imports them from this file.
export { BOT_IDS, isBot };
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/rules/src/matchEngine.test.ts` (it already has `fullDeck()`, `fourPlayers()`, `baseGame()` helpers; extend the top import from `./matchEngine` with `voteRematch, rematchAgreed, createRematch`):

```ts
describe('rematch', () => {
  // A finished match: TeamA reached 7 marks. Only the fields the rematch functions read matter.
  function finishedMatch(overrides: Partial<MatchState> = {}): MatchState {
    return {
      id: 'm1',
      createdOn: '2026-01-01T00:00:00.000Z',
      updatedOn: '2026-01-01T00:00:00.000Z',
      currentGame: baseGame({ id: 'g9', name: 'Game 9', firstActionBy: 'p2' }),
      games: {},
      winningTeam: Teams.TeamA,
      players: fourPlayers().map((p) => ({ ...p, ready: false })),
      ...overrides,
    };
  }

  describe('voteRematch', () => {
    it('records a vote from a seated player on a finished match, even with no votes stored yet', () => {
      const match = finishedMatch();
      expect(match.rematchVotes).toBeUndefined();

      expect(voteRematch(match, 'p3').rematchVotes).toEqual(['p3']);
    });

    it('ignores a repeat vote', () => {
      const once = voteRematch(finishedMatch(), 'p3');
      expect(voteRematch(once, 'p3')).toBe(once);
    });

    it('rejects a vote while the match is still being played', () => {
      expect(() => voteRematch(finishedMatch({ winningTeam: null }), 'p1')).toThrow(ValidationError);
    });

    it('rejects a vote from someone not seated', () => {
      expect(() => voteRematch(finishedMatch(), 'stranger')).toThrow(ValidationError);
    });
  });

  describe('rematchAgreed', () => {
    it('counts voters and every bot, in seat order', () => {
      const match = finishedMatch({
        players: [
          { playerId: 'p1', position: Positions.First, ready: false },
          { playerId: 'bot-1', position: Positions.Second, ready: false },
          { playerId: 'p3', position: Positions.Third, ready: false },
          { playerId: 'bot-2', position: Positions.Fourth, ready: false },
        ],
        rematchVotes: ['p3'],
      });

      expect(rematchAgreed(match)).toEqual(['bot-1', 'p3', 'bot-2']);
    });
  });

  describe('createRematch', () => {
    it('seats the same four at the same positions and deals Game 1', () => {
      const rematch = createRematch('m2', finishedMatch(), fullDeck());

      expect(rematch.id).toBe('m2');
      expect(rematch.winningTeam).toBeNull();
      expect(rematch.games).toEqual({});
      expect(rematch.rematchVotes).toBeUndefined();
      expect(rematch.rematchId).toBeUndefined();
      expect(rematch.players).toEqual(fourPlayers().map((p) => ({ ...p, ready: false })));
      expect(rematch.currentGame.name).toBe('Game 1');
      expect(rematch.currentGame.hands.map((h) => [h.playerId, h.team, h.dominoes.length])).toEqual([
        ['p1', Teams.TeamA, 7],
        ['p2', Teams.TeamB, 7],
        ['p3', Teams.TeamA, 7],
        ['p4', Teams.TeamB, 7],
      ]);
    });

    it('keeps the deal rotating: the seat after the last hand\'s first bidder bids first', () => {
      // The finished match's last hand was opened by p2 (Second), so p3 (Third) opens the rematch.
      const rematch = createRematch('m2', finishedMatch(), fullDeck());

      expect(rematch.currentGame.firstActionBy).toBe('p3');
      expect(rematch.currentGame.currentPlayerId).toBe('p3');
    });

    it('refuses a previous match without four players', () => {
      expect(() => createRematch('m2', finishedMatch({ players: fourPlayers().slice(0, 3) }), fullDeck())).toThrow();
    });
  });
});
```

If `ValidationError` and `Positions` are not already imported in this test file, they are (lines 14-15); `MatchState` is imported as a type on line 12.

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd packages/rules && npm test -- matchEngine`
Expected: FAIL — `voteRematch is not a function` (or a TS import error).

- [ ] **Step 4: Implement**

In `packages/rules/src/matchEngine.ts`:

Add to imports: `import { isBot } from './botIds';`

Extend `MatchState`:

```ts
export interface MatchState {
  id: string;
  createdOn: string;
  updatedOn: string;
  currentGame: Game;
  games: Partial<Record<Teams, Game[]>>;
  winningTeam: Teams | null;
  players: MatchPlayerState[];
  // Who has asked to play the same four again, once the match is over. Optional, like rematchId,
  // because matches stored before rematches existed have neither.
  rematchVotes?: string[];
  // The rematch's match id, set once everyone has agreed and that match exists.
  rematchId?: string;
}
```

Add after `playDomino` (before `getPlayerView`):

```ts
// Asks to play the same four again. Only once the match is over, and only from someone seated;
// asking twice changes nothing.
export function voteRematch(match: MatchState, playerId: string): MatchState {
  if (match.winningTeam === null) throw new ValidationError('This match is still being played');
  assertIsMatchPlayer(match, playerId);

  const votes = match.rematchVotes ?? [];
  if (votes.includes(playerId)) return match;
  return { ...match, rematchVotes: [...votes, playerId], updatedOn: now() };
}

// Everyone who counts as wanting a rematch: those who voted, plus the bots, which never vote but
// never hold one up either. A rematch starts when this covers every seat.
export function rematchAgreed(match: MatchState): string[] {
  const votes = match.rematchVotes ?? [];
  return match.players.map((p) => p.playerId).filter((id) => isBot(id) || votes.includes(id));
}

// A fresh match for the same four, each in the seat they had, with the first hand dealt. The deal
// keeps rotating: the seat after whoever opened the previous match's last hand opens this one.
export function createRematch(id: string, previous: MatchState, dealOrder: Domino[]): MatchState {
  if (previous.players.length !== 4) throw new Error('A rematch needs all four players');

  const timestamp = now();
  const players = previous.players.map((p) => ({ ...p, ready: false }));
  const lastOpener = players.find((p) => p.playerId === previous.currentGame.firstActionBy) ?? players[0];
  const openerPosition = nextPosition(lastOpener.position);
  const firstActionBy = players.find((p) => p.position === openerPosition)!.playerId;

  const hands = dealHands(
    players.map((p) => ({ playerId: p.playerId, team: teamForPosition(p.position), dominoes: [], bid: null })),
    players,
    dealOrder
  );

  return {
    id,
    createdOn: timestamp,
    updatedOn: timestamp,
    currentGame: {
      id: crypto.randomUUID(),
      name: 'Game 1',
      firstActionBy,
      bid: null,
      biddingPlayerId: null,
      trump: null,
      currentPlayerId: firstActionBy,
      hands,
      currentTrick: createTrick(),
      tricks: [],
    },
    games: {},
    winningTeam: null,
    players,
  };
}
```

`ValidationError` is not yet imported in `matchEngine.ts` — add `import { ValidationError } from './errors';`.

Players come out in `previous.players` order (join order); the test's `fourPlayers()` is already in seat order, so the hands assertion holds. Don't sort.

In `packages/rules/src/index.ts`, add `voteRematch, rematchAgreed, createRematch` to the `./matchEngine` export list, and add a line:

```ts
export { BOT_IDS, isBot } from './botIds';
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd packages/rules && npm test`
Expected: PASS, all files.

Run: `cd apps/worker && npm test -- bots`
Expected: PASS (bots.ts now re-exports `isBot`/`BOT_IDS`).

- [ ] **Step 6: Commit**

```bash
git add packages/rules apps/worker/src/bots.ts
git commit -m "Rules: vote for and create a rematch with the same four seats

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Worker — the rematch RPCs and route

**Files:**
- Modify: `apps/worker/src/matchDO.ts`
- Modify: `apps/worker/src/routes/matches.ts` (new route after the `PATCH /:id/players` route)
- Test: `apps/worker/test/matchDORematch.test.ts` (create)
- Test: `apps/worker/test/routes.matches.test.ts` (append)

**Interfaces:**
- Consumes: `voteRematch`, `rematchAgreed`, `createRematch`, `MatchState.rematchId` from Task 1.
- Produces:
  - MatchDO RPC `rematch` body `{ playerId: string }` → the old `MatchState` (with `rematchId` once everyone agreed).
  - MatchDO RPC `createRematch` body `{ matchId: string; previous: MatchState; dealOrder: Domino[] }` → the new `MatchState`. Idempotent.
  - `POST /api/matches/:id/rematch` (no body) → the caller's view of the old match. 400 on a validation error, 404 for an unknown match.

- [ ] **Step 1: Write the failing DO tests**

Create `apps/worker/test/matchDORematch.test.ts`:

```ts
// The rematch flow at MatchDO's RPC boundary: votes collect on the finished match, and the vote
// that completes them creates the rematch's own DO before the old match records its id.
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { Positions, Teams, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';

const testEnv = env as unknown as Env;

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}

// Reads the whole body every time - see matchDO.test.ts's `rpc` for why.
async function rpc(stub: ReturnType<typeof stubFor>, method: string, body: Record<string, unknown>) {
  const res = await stub.fetch(`https://match-do/rpc/${method}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

// A match that just ended (TeamA reached 7), written straight into the DO's storage - playing a
// whole match through the RPCs would bury what these tests are about.
function finishedMatch(id: string, playerIds = ['p1', 'p2', 'p3', 'p4'], winningTeam: Teams | null = Teams.TeamA): MatchState {
  return {
    id,
    createdOn: '2026-01-01T00:00:00.000Z',
    updatedOn: '2026-01-01T00:00:00.000Z',
    winningTeam,
    games: {},
    players: playerIds.map((playerId, position) => ({ playerId, position: position as Positions, ready: false })),
    currentGame: {
      id: 'g9',
      name: 'Game 9',
      firstActionBy: playerIds[0],
      bid: null,
      biddingPlayerId: null,
      trump: null,
      currentPlayerId: playerIds[0],
      hands: playerIds.map((playerId, position) => ({
        playerId,
        team: position % 2 === 0 ? Teams.TeamA : Teams.TeamB,
        dominoes: [],
        bid: null,
      })),
      currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
      tricks: [],
    },
  };
}

async function seed(name: string, match: MatchState) {
  const stub = stubFor(name);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('match', match);
  });
  return stub;
}

describe('MatchDO rematch', () => {
  it('waits for every player, then creates the rematch before recording its id', async () => {
    const stub = await seed('rematch-four', finishedMatch('rematch-four'));

    for (const playerId of ['p1', 'p2', 'p3']) {
      const res = await rpc(stub, 'rematch', { playerId });
      expect(res.status).toBe(200);
      expect((res.body as MatchState).rematchId).toBeUndefined();
    }
    const last = await rpc(stub, 'rematch', { playerId: 'p4' });

    const rematchId = (last.body as MatchState).rematchId!;
    expect(rematchId).toBeTruthy();
    // The new match already exists by the time anyone could learn its id.
    const rematch = await rpc(stubFor(rematchId), 'getMatch', {});
    expect(rematch.status).toBe(200);
    const created = rematch.body as MatchState;
    expect(created.id).toBe(rematchId);
    expect(created.players.map((p) => [p.playerId, p.position])).toEqual([
      ['p1', 0],
      ['p2', 1],
      ['p3', 2],
      ['p4', 3],
    ]);
    expect(created.currentGame.hands.every((h) => h.dominoes.length === 7)).toBe(true);
  });

  it('counts bots as agreeing, so one human can start it alone', async () => {
    const stub = await seed('rematch-bots', finishedMatch('rematch-bots', ['p1', 'bot-1', 'bot-2', 'bot-3']));

    const res = await rpc(stub, 'rematch', { playerId: 'p1' });

    expect((res.body as MatchState).rematchId).toBeTruthy();
  });

  it('does not create a second rematch or redeal on a repeat vote', async () => {
    const stub = await seed('rematch-repeat', finishedMatch('rematch-repeat', ['p1', 'bot-1', 'bot-2', 'bot-3']));
    const first = (await rpc(stub, 'rematch', { playerId: 'p1' })).body as MatchState;
    const dealt = (await rpc(stubFor(first.rematchId!), 'getMatch', {})).body as MatchState;

    const again = (await rpc(stub, 'rematch', { playerId: 'p1' })).body as MatchState;

    expect(again.rematchId).toBe(first.rematchId);
    const after = (await rpc(stubFor(first.rematchId!), 'getMatch', {})).body as MatchState;
    expect(after.currentGame.id).toBe(dealt.currentGame.id);
    expect(after.currentGame.hands).toEqual(dealt.currentGame.hands);
  });

  it('rejects a vote on a match that is still being played', async () => {
    const stub = await seed('rematch-early', finishedMatch('rematch-early', undefined, null));

    const res = await rpc(stub, 'rematch', { playerId: 'p1' });

    expect(res.status).toBe(400);
  });

  it('rejects a vote from someone not seated', async () => {
    const stub = await seed('rematch-stranger', finishedMatch('rematch-stranger'));

    const res = await rpc(stub, 'rematch', { playerId: 'stranger' });

    expect(res.status).toBe(400);
  });

  it('lists the rematch in D1 as active for its players', async () => {
    const stub = await seed('rematch-lobby', finishedMatch('rematch-lobby', ['lobby-p1', 'bot-1', 'bot-2', 'bot-3']));

    const { rematchId } = (await rpc(stub, 'rematch', { playerId: 'lobby-p1' })).body as MatchState;

    const row = await testEnv.DB.prepare(
      `SELECT m.status FROM matches m JOIN match_players mp ON mp.match_id = m.id WHERE m.id = ? AND mp.player_id = ?`
    )
      .bind(rematchId, 'lobby-p1')
      .first<{ status: string }>();
    expect(row?.status).toBe('active');
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd apps/worker && npm test -- matchDORematch`
Expected: FAIL — `rematch` returns 404 `Unknown method`.

- [ ] **Step 3: Implement the RPCs**

In `apps/worker/src/matchDO.ts`:

Add `voteRematch`, `rematchAgreed`, `createRematch` to the `@fortytwo/rules` import.

In `handleRpc`, right after the `create` block and before `const existing = await this.load();`:

```ts
    // The other way a match comes into being: the finished match's DO (the `rematch` case below)
    // calls this on the rematch's DO. Returns an existing match untouched, so a retried call can't
    // redeal it.
    if (method === 'createRematch') {
      const stored = await this.load();
      if (stored !== null) return stored;

      const next = createRematch(body.matchId as string, body.previous as MatchState, body.dealOrder as Domino[]);
      await this.save(next);
      this.broadcast(next);
      // No route touches this match on its way in, so the lobby index is synced here, as alarm() does.
      await this.syncLobbyIndex(next);
      await this.scheduleBotsIfNeeded(next);
      return next;
    }
```

Add to the `switch`:

```ts
      case 'rematch':
        next = await this.rematch(existing, body.playerId as string);
        break;
```

Add the method next to `addBots`:

```ts
  // Records a rematch vote. The vote that completes the table creates the rematch's DO before this
  // match records its id, so no client, all of which follow `rematchId` off the broadcast, can
  // arrive there first. The id is saved before that call: DO input is only gated on storage, not
  // on an outgoing fetch, so a second vote can run while it's in flight and must reuse the id
  // rather than mint another. A vote after the id exists re-runs the (idempotent) creation, which
  // finishes the job if an earlier attempt failed partway.
  private async rematch(match: MatchState, playerId: string): Promise<MatchState> {
    let next = voteRematch(match, playerId);
    if (rematchAgreed(next).length < next.players.length) return next;

    if (next.rematchId === undefined) {
      next = { ...next, rematchId: crypto.randomUUID() };
      await this.save(next);
    }

    const rematchDO = this.env.MATCH_DO.get(this.env.MATCH_DO.idFromName(next.rematchId));
    const res = await rematchDO.fetch('https://do/rpc/createRematch', {
      method: 'POST',
      body: JSON.stringify({ matchId: next.rematchId, previous: next, dealOrder: shuffledDominoOrder() }),
    });
    await res.json();
    if (!res.ok) throw new Error(`Creating rematch ${next.rematchId} failed with ${res.status}`);
    return next;
  }
```

Replace the D1 block in `alarm()` with a call to a shared helper, and add the helper:

```ts
  async alarm(): Promise<void> {
    const match = await this.load();
    if (match === null) return;

    const action = findNextBotAction(match);
    if (action === null) return;

    const next = this.applyBotAction(match, action);
    await this.save(next);
    this.broadcast(next);
    await this.syncLobbyIndex(next);
    await this.scheduleBotsIfNeeded(next);
  }

  // Keeps the D1 lobby index (lobby.ts) in step for changes that don't come through
  // routes/matches.ts, which syncs everything else.
  private async syncLobbyIndex(match: MatchState): Promise<void> {
    await upsertMatchSummary(this.env.DB, {
      id: match.id,
      status: match.winningTeam ? 'completed' : 'active',
      playerCount: match.players.length,
      updatedOn: match.updatedOn,
    });
    await syncMatchPlayers(this.env.DB, match.id, match.players);
  }
```

Keep the existing comment above `alarm()` ("Runs one bot action per firing, syncing the D1 lobby index ...").

- [ ] **Step 4: Run to see them pass**

Run: `cd apps/worker && npm test -- matchDORematch`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

Append inside the `describe('match routes', ...)` block of `apps/worker/test/routes.matches.test.ts`. Add `runInDurableObject` to the `cloudflare:test` import and `Positions, Teams, type MatchState` from `@fortytwo/rules` (check existing imports first; add only what's missing):

```ts
  it('collects rematch votes and hands every voter the rematch once all four agree', async () => {
    const tokens = await Promise.all(['p1', 'p2', 'p3', 'p4'].map(signToken));
    const matchId = crypto.randomUUID();
    const finished: MatchState = {
      id: matchId,
      createdOn: '2026-01-01T00:00:00.000Z',
      updatedOn: '2026-01-01T00:00:00.000Z',
      winningTeam: Teams.TeamB,
      games: {},
      players: ['p1', 'p2', 'p3', 'p4'].map((playerId, position) => ({ playerId, position: position as Positions, ready: false })),
      currentGame: {
        id: 'g9',
        name: 'Game 9',
        firstActionBy: 'p1',
        bid: null,
        biddingPlayerId: null,
        trump: null,
        currentPlayerId: 'p1',
        hands: ['p1', 'p2', 'p3', 'p4'].map((playerId, i) => ({
          playerId,
          team: i % 2 === 0 ? Teams.TeamA : Teams.TeamB,
          dominoes: [],
          bid: null,
        })),
        currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
        tricks: [],
      },
    };
    await runInDurableObject(testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(matchId)), async (_i, state) => {
      await state.storage.put('match', finished);
    });

    const stranger = await api(`/api/matches/${matchId}/rematch`, await signToken('stranger'), { method: 'POST' });
    expect(stranger.status).toBe(400);
    await stranger.json();

    let last: MatchState | undefined;
    for (const token of tokens) {
      const res = await api(`/api/matches/${matchId}/rematch`, token, { method: 'POST' });
      expect(res.status).toBe(200);
      last = await res.json();
    }

    expect(last!.rematchId).toBeTruthy();
    const rematch = await api(`/api/matches/${last!.rematchId}`, tokens[0]);
    expect(rematch.status).toBe(200);
    const body: MatchState = await rematch.json();
    expect(body.players).toHaveLength(4);
    // Still only the caller's own hand in full.
    expect(body.currentGame.hands.find((h) => h.playerId === 'p1')!.dominoes).toHaveLength(7);
    expect(body.currentGame.hands.find((h) => h.playerId === 'p2')!.dominoes).toHaveLength(0);
  });
```

- [ ] **Step 6: Run to see it fail**

Run: `cd apps/worker && npm test -- routes.matches`
Expected: FAIL — the rematch POST gets a 404 from Hono.

- [ ] **Step 7: Add the route**

In `apps/worker/src/routes/matches.ts`, after the `matches.patch('/:id/players', ...)` route:

```ts
// A vote to play the same four again once the match is over. The vote that completes the table
// also creates the rematch (MatchDO's `rematch`), which syncs its own lobby row; this route only
// syncs the finished match.
matches.post('/:id/rematch', async (c) => {
  const matchId = c.req.param('id');
  const res = await callRpc(stub(c, matchId), 'rematch', { playerId: c.get('user').sub });
  if (res.status !== 200) return c.json(await res.json(), res.status as 400);
  const match: MatchState = await res.json();
  await syncLobby(c, matchId, match);
  return c.json(matchView(c, match));
});
```

- [ ] **Step 8: Run the whole worker suite**

Run: `cd apps/worker && npm test`
Expected: PASS, all files.

- [ ] **Step 9: Commit**

```bash
git add apps/worker
git commit -m "Worker: collect rematch votes and create the rematch once all four agree

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Web — API call, info toast, and a fresh page per match

**Files:**
- Modify: `apps/web/src/api/client.ts` (after `readyUp`)
- Modify: `apps/web/src/ui/toast.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/pages/Match.tsx` (add `MatchRoute` export)
- Test: `apps/web/src/ui/toast.test.ts`

**Interfaces:**
- Produces:
  - `apiClient(...).rematch(id: string): Promise<MatchState>`
  - `toastInfo(title: string, text?: string): void`
  - `MatchRoute(): JSX.Element` in `pages/Match.tsx` — renders `<Match key={matchId} />`

- [ ] **Step 1: Write the failing test**

`apps/web/src/ui/toast.test.ts` renders real SweetAlert2 toasts into jsdom and reads them back with `Swal.getTitle()` etc. Change its import to `import { toastError, toastInfo } from './toast';` and append:

```ts
describe('toastInfo', () => {
  it('shows an info toast with the given title and text', () => {
    toastInfo('Game 4 dealt', 'Alice bids first');

    expect(Swal.getTitle()?.textContent).toBe('Game 4 dealt');
    expect(Swal.getHtmlContainer()?.textContent).toBe('Alice bids first');
    expect(Swal.getIcon()?.classList.contains('swal2-info')).toBe(true);
    expect(Swal.getPopup()?.classList.contains('hall-toast')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd apps/web && npm test -- toast`
Expected: FAIL — `toastInfo` is not exported.

- [ ] **Step 3: Implement**

Append to `apps/web/src/ui/toast.ts`:

```ts
// A heads-up rather than an error - e.g. the next hand being dealt while you looked away. Turn
// notifications (#2) can build on this.
export function toastInfo(title: string, text?: string): void {
  void Toast.fire({ icon: 'info', title, text });
}
```

Add to `apiClient` in `apps/web/src/api/client.ts`, after `readyUp`:

```ts
    // A vote to play the same four again once the match is over.
    rematch: (id: string): Promise<MatchState> =>
      request<MatchState>(getToken, `/api/matches/${id}/rematch`, { method: 'POST' }),
```

Add to the end of `apps/web/src/pages/Match.tsx` (add `useParams` is already imported):

```tsx
// The /match/:matchId route. Keyed by id so following a rematch mounts a fresh page: the trick
// hold, the sweep, and the new-hand tracker all belong to one match and mustn't carry over.
export function MatchRoute(): JSX.Element {
  const { matchId } = useParams<{ matchId: string }>();
  return <Match key={matchId} />;
}
```

In `apps/web/src/main.tsx`, import `MatchRoute` instead of `Match` and change the route to:

```tsx
              <Route path="/match/:matchId" element={<MatchRoute />} />
```

- [ ] **Step 4: Run tests, lint and build**

Run: `cd apps/web && npm test && npm run lint && npm run build`
Expected: tests PASS, no new lint warnings, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/src/ui apps/web/src/main.tsx apps/web/src/pages/Match.tsx
git commit -m "Match: add the rematch call and an info toast, and remount per match

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Web — the match summary dialog component

**Files:**
- Create: `apps/web/src/match/summary.ts`
- Create: `apps/web/src/components/MatchSummary.tsx`
- Modify: `apps/web/src/styles/match.css` (append)
- Test: `apps/web/src/match/summary.test.ts`, `apps/web/src/components/MatchSummary.test.tsx`

**Interfaces:**
- Consumes: `rematchAgreed`, `gameValue`, `gameWinningTeam`, `bidToPrettyString`, `suitToPrettyString`, `matchScores` from `@fortytwo/rules`.
- Produces:
  - `interface PlayedHand { game: Game; winner: Teams; made: boolean; marks: number }`
  - `playedHands(match: MatchState): PlayedHand[]` — every filed hand in game order
  - `MatchSummary` component, props:
    ```ts
    {
      match: MatchState;
      myTeam: Teams;
      nameFor: (playerId: string | null) => string;
      iVoted: boolean;
      rematchDisabled: boolean;
      onRematch: () => void;
      onClose: () => void;
    }
    ```

- [ ] **Step 1: Write the failing helper test**

Create `apps/web/src/match/summary.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Bid, Suit, Teams, type Game, type MatchState } from '@fortytwo/rules';
import { playedHands } from './summary';

function hand(name: string, bidder: string, bid: Bid, trump: Suit, bidderTeam: Teams): Game {
  return {
    id: name,
    name,
    firstActionBy: 'p1',
    bid,
    biddingPlayerId: bidder,
    trump,
    currentPlayerId: null,
    hands: [
      { playerId: bidder, team: bidderTeam, dominoes: [], bid },
      { playerId: 'other', team: bidderTeam === Teams.TeamA ? Teams.TeamB : Teams.TeamA, dominoes: [], bid: Bid.Pass },
    ],
    currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
    tricks: [],
  };
}

describe('playedHands', () => {
  it('lists both teams\' hands in game order, marking each made or set', () => {
    const match = {
      games: {
        [Teams.TeamA]: [hand('Game 1', 'p1', Bid.Thirty, Suit.Fives, Teams.TeamA), hand('Game 10', 'p1', Bid.EightyFour, Suit.Sixes, Teams.TeamA)],
        [Teams.TeamB]: [hand('Game 2', 'p1', Bid.ThirtyOne, Suit.Aces, Teams.TeamA)],
      },
    } as unknown as MatchState;

    expect(playedHands(match).map((h) => [h.game.name, h.winner, h.made, h.marks])).toEqual([
      ['Game 1', Teams.TeamA, true, 1],
      ['Game 2', Teams.TeamB, false, 1],
      ['Game 10', Teams.TeamA, true, 2],
    ]);
  });

  it('is empty when no hand has been decided', () => {
    expect(playedHands({ games: {} } as MatchState)).toEqual([]);
  });
});
```

Check `packages/rules/src/bid.ts` for the exact enum member names (`Thirty`, `ThirtyOne`, `EightyFour`); adjust if they differ.

- [ ] **Step 2: Run to see it fail**

Run: `cd apps/web && npm test -- summary`
Expected: FAIL — cannot resolve `./summary`.

- [ ] **Step 3: Implement the helper**

Create `apps/web/src/match/summary.ts`:

```ts
// The hands a finished match was played over, for the match-over summary. A hand is filed under
// the team that took it (matchEngine.ts's playDomino) as soon as it's decided, so the filed games
// are exactly the decided hands; the key is the winner.
import { gameValue, Teams, type Game, type MatchState } from '@fortytwo/rules';

export interface PlayedHand {
  game: Game;
  winner: Teams;
  // Whether the bidding team took the hand.
  made: boolean;
  // Marks the hand scored for its winner.
  marks: number;
}

// "Game 10" sorts after "Game 9": by the number in the name, which counts up one per hand.
function gameNumber(game: Game): number {
  return Number(game.name.replace(/\D/g, '')) || 0;
}

export function playedHands(match: MatchState): PlayedHand[] {
  const hands: PlayedHand[] = [];
  for (const [key, games] of Object.entries(match.games) as [string, Game[] | undefined][]) {
    const winner = Number(key) as Teams;
    for (const game of games ?? []) {
      const bidderTeam = game.hands.find((h) => h.playerId === game.biddingPlayerId)?.team ?? null;
      hands.push({ game, winner, made: bidderTeam === winner, marks: gameValue(game) ?? 0 });
    }
  }
  return hands.sort((a, b) => gameNumber(a.game) - gameNumber(b.game));
}
```

- [ ] **Step 4: Run to see it pass**

Run: `cd apps/web && npm test -- summary`
Expected: PASS.

- [ ] **Step 5: Write the failing component test**

Create `apps/web/src/components/MatchSummary.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bid, Positions, Suit, Teams, type Game, type MatchState } from '@fortytwo/rules';
import { MatchSummary } from './MatchSummary';

afterEach(cleanup);

function game(name: string, bidder: string, bid: Bid, trump: Suit, bidderTeam: Teams): Game {
  return {
    id: name,
    name,
    firstActionBy: 'p1',
    bid,
    biddingPlayerId: bidder,
    trump,
    currentPlayerId: null,
    hands: [{ playerId: bidder, team: bidderTeam, dominoes: [], bid }],
    currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
    tricks: [],
  };
}

function finishedMatch(overrides: Partial<MatchState> = {}): MatchState {
  return {
    id: 'match-1',
    createdOn: '',
    updatedOn: '',
    winningTeam: Teams.TeamA,
    players: [
      { playerId: 'p1', position: Positions.First, ready: false },
      { playerId: 'p2', position: Positions.Second, ready: false },
      { playerId: 'p3', position: Positions.Third, ready: false },
      { playerId: 'p4', position: Positions.Fourth, ready: false },
    ],
    games: {
      [Teams.TeamA]: [game('Game 1', 'p1', Bid.EightyFour, Suit.Fives, Teams.TeamA)],
      [Teams.TeamB]: [game('Game 2', 'p1', Bid.Thirty, Suit.Aces, Teams.TeamA)],
    },
    currentGame: game('Game 2', 'p1', Bid.Thirty, Suit.Aces, Teams.TeamA),
    ...overrides,
  };
}

const names: Record<string, string> = { p1: 'You', p2: 'Bea', p3: 'Cal', p4: 'Dee' };

function renderSummary(props: Partial<Parameters<typeof MatchSummary>[0]> = {}) {
  const handlers = { onRematch: vi.fn(), onClose: vi.fn() };
  render(
    <MemoryRouter>
      <MatchSummary
        match={finishedMatch()}
        myTeam={Teams.TeamA}
        nameFor={(id) => (id == null ? '' : names[id])}
        iVoted={false}
        rematchDisabled={false}
        {...handlers}
        {...props}
      />
    </MemoryRouter>
  );
  return handlers;
}

describe('MatchSummary', () => {
  it('names the winner, both teams and their marks', () => {
    renderSummary();

    const dialog = screen.getByRole('dialog', { name: /you won the match/i });
    expect(within(dialog).getByText('You & Cal')).not.toBeNull();
    expect(within(dialog).getByText('Bea & Dee')).not.toBeNull();
    expect(within(dialog).getByTestId('final-marks-us').textContent).toBe('2');
    expect(within(dialog).getByTestId('final-marks-them').textContent).toBe('1');
  });

  it('says they won when the other team did', () => {
    renderSummary({ myTeam: Teams.TeamB });
    expect(screen.getByRole('dialog', { name: /they won the match/i })).not.toBeNull();
  });

  it('lists each hand in order with its bidder, bid, trump and result', () => {
    renderSummary();

    const rows = screen.getAllByRole('row').slice(1); // skip the header row
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/Game 1.*You.*84.*Fives.*Made.*\+2/),
      expect.stringMatching(/Game 2.*You.*30.*Aces.*Set.*\+1/),
    ]);
  });

  it('links back to the lobby', () => {
    renderSummary();
    expect(screen.getByRole('link', { name: /back to lobby/i }).getAttribute('href')).toBe('/');
  });

  it('votes for a rematch', () => {
    const { onRematch } = renderSummary();
    fireEvent.click(screen.getByRole('button', { name: /^rematch/i }));
    expect(onRematch).toHaveBeenCalled();
  });

  it('shows how many have agreed once I have voted, counting bots, with no votes stored', () => {
    renderSummary({
      iVoted: true,
      match: finishedMatch({
        players: [
          { playerId: 'p1', position: Positions.First, ready: false },
          { playerId: 'bot-1', position: Positions.Second, ready: false },
          { playerId: 'p3', position: Positions.Third, ready: false },
          { playerId: 'p4', position: Positions.Fourth, ready: false },
        ],
        rematchVotes: ['p1'],
      }),
    });

    const button = screen.getByRole('button', { name: /waiting for rematch \(2 of 4\)/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('closes', () => {
    const { onClose } = renderSummary();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

The bid labels come from `bidToPrettyString` (check its output for `EightyFour` — if it renders "84 (2 marks)" or "2 Marks", adjust the regex to match what it actually returns rather than changing the helper).

- [ ] **Step 6: Run to see it fail**

Run: `cd apps/web && npm test -- MatchSummary`
Expected: FAIL — cannot resolve `./MatchSummary`.

- [ ] **Step 7: Implement the component**

Create `apps/web/src/components/MatchSummary.tsx`:

```tsx
// The match-over dialog: who won, each team and its final marks, every hand played, and the way
// on - back to the lobby, or a rematch with the same four once everyone asks for one. Everything
// here comes from the MatchState the page already holds.
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import {
  Teams,
  bidToPrettyString,
  matchScores,
  rematchAgreed,
  suitToPrettyString,
  type MatchState,
} from '@fortytwo/rules';
import { playedHands } from '../match/summary';

interface MatchSummaryProps {
  match: MatchState;
  myTeam: Teams;
  nameFor: (playerId: string | null) => string;
  iVoted: boolean;
  rematchDisabled: boolean;
  onRematch: () => void;
  onClose: () => void;
}

function teamOf(position: number): Teams {
  return position % 2 === 0 ? Teams.TeamA : Teams.TeamB;
}

export function MatchSummary({
  match,
  myTeam,
  nameFor,
  iVoted,
  rematchDisabled,
  onRematch,
  onClose,
}: MatchSummaryProps): JSX.Element {
  const theirTeam = myTeam === Teams.TeamA ? Teams.TeamB : Teams.TeamA;
  const scores = matchScores(match);
  const title = match.winningTeam === myTeam ? 'You won the match' : 'They won the match';
  const namesOn = (team: Teams) =>
    match.players
      .filter((p) => teamOf(p.position) === team)
      .map((p) => nameFor(p.playerId))
      .join(' & ');
  const agreed = rematchAgreed(match).length;

  return (
    <div className="match-summary-backdrop">
      <div className="match-summary" role="dialog" aria-modal="true" aria-labelledby="match-summary-title">
        <button type="button" className="match-summary-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <h2 id="match-summary-title" className="match-summary-title">
          {title}
        </h2>

        <div className="match-summary-teams">
          <div className="match-summary-team match-summary-us">
            <span className="match-summary-names">{namesOn(myTeam)}</span>
            <span className="match-summary-marks" data-testid="final-marks-us">
              {scores[myTeam] ?? 0}
            </span>
          </div>
          <div className="match-summary-team match-summary-them">
            <span className="match-summary-names">{namesOn(theirTeam)}</span>
            <span className="match-summary-marks" data-testid="final-marks-them">
              {scores[theirTeam] ?? 0}
            </span>
          </div>
        </div>

        <div className="match-summary-hands">
          <table>
            <thead>
              <tr>
                <th scope="col">Hand</th>
                <th scope="col">Bidder</th>
                <th scope="col">Bid</th>
                <th scope="col">Trump</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {playedHands(match).map(({ game, winner, made, marks }) => (
                <tr key={game.id} className={winner === myTeam ? 'hand-us' : 'hand-them'}>
                  <td>{game.name}</td>
                  <td>{nameFor(game.biddingPlayerId)}</td>
                  <td>{game.bid == null ? '' : bidToPrettyString(game.bid)}</td>
                  <td>{game.trump == null ? '' : suitToPrettyString(game.trump)}</td>
                  <td>
                    {made ? 'Made' : 'Set'} <span className="match-summary-hand-marks">+{marks}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="match-summary-actions">
          <Link to="/" className="btn btn-outline-secondary">
            Back to lobby
          </Link>
          <button type="button" className="action-button" disabled={iVoted || rematchDisabled} onClick={onRematch}>
            {iVoted ? `Waiting for rematch (${agreed} of 4)` : agreed > 0 ? `Rematch (${agreed} of 4)` : 'Rematch'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Append to `apps/web/src/styles/match.css`:

```css
/* ---------- Match over: the summary dialog ---------- */

/* Dims everything behind the dialog so the table reads as finished; closing the dialog uncovers
   it. Fixed rather than absolute: .match isn't a positioning context. */
.match-summary-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(12, 8, 5, 0.6);
}

.match-summary {
  position: relative;
  width: min(36rem, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding: 1.25rem 1.25rem 1rem;
  border-radius: 1rem;
  background: linear-gradient(var(--walnut-deep), #1b120d);
  box-shadow:
    inset 0 0 0 1px rgba(242, 234, 219, 0.12),
    0 24px 60px -20px rgba(0, 0, 0, 0.8);
  color: var(--bone);
}

.match-summary-close {
  position: absolute;
  top: 0.5rem;
  right: 0.75rem;
  border: 0;
  background: none;
  color: var(--ink-muted);
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
}

.match-summary-title {
  margin: 0;
  text-align: center;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.6rem;
  color: var(--brass);
}

.match-summary-teams {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem;
}

.match-summary-team {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.6rem;
  background: rgba(20, 13, 9, 0.6);
  box-shadow: inset 3px 0 0 var(--team);
}

.match-summary-us {
  --team: var(--us);
}

.match-summary-them {
  --team: var(--them);
}

.match-summary-marks {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.5rem;
}

/* The hand list is the one part that grows with the match, so it scrolls instead of the dialog. */
.match-summary-hands {
  min-height: 0;
  overflow-y: auto;
}

.match-summary-hands table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.match-summary-hands th {
  text-align: left;
  font-weight: 600;
  color: var(--ink-muted);
  border-bottom: 1px solid rgba(242, 234, 219, 0.12);
}

.match-summary-hands th,
.match-summary-hands td {
  padding: 0.3rem 0.4rem;
}

.match-summary-hands .hand-us td:last-child {
  color: var(--us);
}

.match-summary-hands .hand-them td:last-child {
  color: var(--them);
}

.match-summary-actions {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 0.6rem;
}

@media (max-width: 575.98px) {
  .match-summary-teams {
    grid-template-columns: 1fr;
  }

  .match-summary-hands th:nth-child(2),
  .match-summary-hands td:nth-child(2) {
    display: none;
  }
}
```

`--us`, `--them` and `--walnut-deep` are defined in `styles/hall.css`; `.action-button` and `.btn` are existing global styles.

- [ ] **Step 8: Run to see it pass**

Run: `cd apps/web && npm test -- MatchSummary summary`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/match/summary.ts apps/web/src/match/summary.test.ts apps/web/src/components/MatchSummary.tsx apps/web/src/components/MatchSummary.test.tsx apps/web/src/styles/match.css
git commit -m "Match: a match-over summary of the teams, marks and every hand

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Web — wire the summary, rematch and new-hand toast into the match page

**Files:**
- Modify: `apps/web/src/pages/Match.tsx`
- Test: `apps/web/src/pages/Match.test.tsx`

**Interfaces:**
- Consumes: `MatchSummary` (Task 4), `apiClient().rematch` and `toastInfo` (Task 3), `MatchState.rematchId`/`rematchVotes` (Task 1).

- [ ] **Step 1: Update the test harness mocks**

In `apps/web/src/pages/Match.test.tsx`:
- Add `rematchMock`, `toastInfoMock`, `navigateMock` to the `vi.hoisted` block (each `vi.fn()`) and destructure them.
- Add `rematch: rematchMock,` to the mocked `apiClient`.
- Change the toast mock to `vi.mock('../ui/toast', () => ({ toastError: toastErrorMock, toastInfo: toastInfoMock }));`
- In the `react-router-dom` mock, return `{ ...actual, useParams: () => ({ matchId: 'match-1' }), useNavigate: () => navigateMock }`.

- [ ] **Step 2: Write the failing tests**

Append a new `describe` inside `describe('Match', ...)`:

```tsx
  describe('match over', () => {
    // The last hand of a finished match: TeamA (p1/p3) bid Thirty and took it, reaching 7 marks.
    function finishedMatch(overrides: Partial<MatchState> = {}): MatchState {
      const lastHand = {
        bid: Bid.Thirty,
        biddingPlayerId: 'p1',
        trump: Suit.Sixes,
        hands: [
          { playerId: 'p1', team: Teams.TeamA, dominoes: [], bid: Bid.Thirty },
          { playerId: 'p2', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
          { playerId: 'p3', team: Teams.TeamA, dominoes: [], bid: Bid.Pass },
          { playerId: 'p4', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
        ],
        tricks: [
          {
            playerId: 'p1',
            team: Teams.TeamA,
            suit: Suit.Sixes,
            dominoes: [createDomino(5, 0), createDomino(5, 5), createDomino(6, 4), createDomino(4, 1)],
          },
        ],
      };
      const base = baseMatch({ winningTeam: Teams.TeamA }, lastHand);
      return { ...base, games: { [Teams.TeamA]: [base.currentGame] }, ...overrides };
    }

    it('opens the summary dialog once the match is over', () => {
      useMatchSocketMock.mockReturnValue({ match: finishedMatch(), connected: true });
      renderMatch();

      const dialog = screen.getByRole('dialog', { name: /you won the match/i });
      expect(within(dialog).getByText('Game 1')).not.toBeNull();
    });

    it('does not show the summary while the match is on', () => {
      useMatchSocketMock.mockReturnValue({ match: baseMatch(), connected: true });
      renderMatch();

      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('votes for a rematch', async () => {
      rematchMock.mockResolvedValue(finishedMatch());
      useMatchSocketMock.mockReturnValue({ match: finishedMatch(), connected: true });
      renderMatch();

      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^rematch/i }));

      await waitFor(() => expect(rematchMock).toHaveBeenCalledWith('match-1'));
    });

    it('shows my vote as waiting, with the count', () => {
      useMatchSocketMock.mockReturnValue({ match: finishedMatch({ rematchVotes: ['p1', 'p2'] }), connected: true });
      renderMatch();

      expect(within(screen.getByRole('dialog')).getByRole('button', { name: /waiting for rematch \(2 of 4\)/i })).not.toBeNull();
    });

    it('closes to the table, leaving a way back to the summary', () => {
      useMatchSocketMock.mockReturnValue({ match: finishedMatch(), connected: true });
      renderMatch();

      fireEvent.click(screen.getByRole('button', { name: /close/i }));
      expect(screen.queryByRole('dialog')).toBeNull();
      const rail = screen.getByRole('region', { name: /hand over/i });
      expect(within(rail).getByText(/you won the match/i)).not.toBeNull();

      fireEvent.click(within(rail).getByRole('button', { name: /match summary/i }));
      expect(screen.getByRole('dialog')).not.toBeNull();
    });

    it('can vote from the rail with the dialog closed', async () => {
      rematchMock.mockResolvedValue(finishedMatch());
      useMatchSocketMock.mockReturnValue({ match: finishedMatch(), connected: true });
      renderMatch();

      fireEvent.click(screen.getByRole('button', { name: /close/i }));
      const rail = screen.getByRole('region', { name: /hand over/i });
      fireEvent.click(within(rail).getByRole('button', { name: /^rematch/i }));

      await waitFor(() => expect(rematchMock).toHaveBeenCalledWith('match-1'));
    });

    it('follows the rematch once everyone has agreed', () => {
      useMatchSocketMock.mockReturnValue({ match: finishedMatch({ rematchId: 'match-2' }), connected: true });
      renderMatch();

      expect(navigateMock).toHaveBeenCalledWith('/match/match-2');
    });
  });

  describe('new hand cue', () => {
    it('toasts when the next hand is dealt, naming who bids first', () => {
      useMatchSocketMock.mockReturnValue({ match: baseMatch(), connected: true });
      const view = renderMatch();
      expect(toastInfoMock).not.toHaveBeenCalled();

      useMatchSocketMock.mockReturnValue({
        match: baseMatch({}, { id: 'g2', name: 'Game 2', firstActionBy: 'p2', currentPlayerId: 'p2' }),
        connected: true,
      });
      view.rerender(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <Match />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(toastInfoMock).toHaveBeenCalledWith('Game 2 dealt', 'p2 bids first');
    });

    it('says "You bid first" when it\'s me', () => {
      useMatchSocketMock.mockReturnValue({ match: baseMatch(), connected: true });
      const view = renderMatch();

      useMatchSocketMock.mockReturnValue({
        match: baseMatch({}, { id: 'g2', name: 'Game 2', firstActionBy: 'p1' }),
        connected: true,
      });
      view.rerender(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <Match />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(toastInfoMock).toHaveBeenCalledWith('Game 2 dealt', 'You bid first');
    });
  });
```

Note: rerendering with a *new* `QueryClient` remounts nothing that matters here (the `Match` element type and position are unchanged, so React keeps its state and refs); if it does cause a remount in practice, change `renderMatch` to return the `queryClient` and reuse it in `rerender`.

- [ ] **Step 3: Run to see them fail**

Run: `cd apps/web && npm test -- Match.test`
Expected: the new tests FAIL (no dialog, no toast, no navigate); existing tests still PASS.

- [ ] **Step 4: Implement in `Match.tsx`**

1. Imports: add `useNavigate` to the `react-router-dom` import; add `import { MatchSummary } from '../components/MatchSummary';`; change the toast import to `import { toastError, toastInfo } from '../ui/toast';`.

2. Update the header comment's last sentence (lines 18-19): replace `its "next game started" / "match over" modals are still not ported.` with:

```ts
// When the match ends, a summary dialog (components/MatchSummary.tsx) replaces the old app's
// "match over" modal and offers a rematch; a toast stands in for its "next game started" one.
```

3. Next to the other mutations (after `readyUpMutation`):

```tsx
  const rematchMutation = useMutation({
    mutationFn: () => client.rematch(matchId!),
    onError: toastError,
  });
  // The summary opens by itself when the match ends; closing it uncovers the final table, and
  // the rail keeps a button to bring it back.
  const [summaryOpen, setSummaryOpen] = useState(true);
  const navigate = useNavigate();
```

4. Before the `if (!matchId)` early return (hooks must run unconditionally), add:

```tsx
  // Everyone asked for a rematch and it now exists (MatchDO creates it before recording the id),
  // so take this player there. MatchRoute keys the page by match id, so it starts fresh.
  const rematchId = match?.rematchId;
  useEffect(() => {
    if (rematchId) navigate(`/match/${rematchId}`);
  }, [rematchId, navigate]);

  // A cue that the next hand is out, for anyone who readied up and looked away: bidding has
  // started without them. Only on a change of hand - never for the one the page opened on.
  const dealtGame = match?.currentGame ?? null;
  const seenGameIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!dealtGame) return;
    const previousId = seenGameIdRef.current;
    seenGameIdRef.current = dealtGame.id;
    if (previousId === null || previousId === dealtGame.id) return;
    const opener = dealtGame.firstActionBy;
    const who =
      opener === myPlayerId ? 'You bid first' : `${(opener && namesQuery.data?.get(opener)) ?? opener} bids first`;
    toastInfo(`${dealtGame.name} dealt`, who);
  }, [dealtGame, myPlayerId, namesQuery.data]);
```

5. Replace the `showHandOver` section (the `<section className="hand-result" ...>` block) with:

```tsx
            {showHandOver && (
              <section className="hand-result" aria-label="Hand over">
                <p className="hand-result-title">
                  {isMatchOver
                    ? match.winningTeam === me.team
                      ? 'You won the match'
                      : 'They won the match'
                    : handWinner === me.team
                      ? 'We took the hand'
                      : 'They took the hand'}
                </p>
                {isMatchOver ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-secondary"
                      onClick={() => setSummaryOpen(true)}
                    >
                      Match summary
                    </button>
                    <button
                      type="button"
                      className="action-button"
                      disabled={iVotedRematch || !connected || rematchMutation.isPending}
                      onClick={() => rematchMutation.mutate()}
                    >
                      {iVotedRematch ? `Waiting for rematch (${rematchAgreed(match).length} of 4)` : 'Rematch'}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="hand-result-note">
                      {iAmReady
                        ? `Waiting for everyone to ready up (${readyCount} of 4)`
                        : isHandPlayedOut
                          ? 'Ready up for the next hand'
                          : 'Play it out, or ready up for the next hand'}
                    </p>
                    <button
                      type="button"
                      className="action-button"
                      disabled={iAmReady || !connected || readyUpMutation.isPending}
                      onClick={() => readyUpMutation.mutate()}
                    >
                      {iAmReady ? "You're ready" : 'Ready up'}
                    </button>
                  </>
                )}
              </section>
            )}
```

Add `rematchAgreed` to the `@fortytwo/rules` import, and next to `iAmReady` add:

```tsx
  const iVotedRematch = match.rematchVotes?.includes(myPlayerId) ?? false;
```

6. Just before the closing `</div>` of the root `<div ref={matchRootRef} className="match">`, render the dialog:

```tsx
      {showHandOver && isMatchOver && summaryOpen && (
        <MatchSummary
          match={match}
          myTeam={me.team}
          nameFor={nameFor}
          iVoted={iVotedRematch}
          rematchDisabled={!connected || rematchMutation.isPending}
          onRematch={() => rematchMutation.mutate()}
          onClose={() => setSummaryOpen(false)}
        />
      )}
```

`nameFor` returns `'You'` for me, so the summary shows "You & Cal" — intended.

- [ ] **Step 5: Run tests, lint and build**

Run: `cd apps/web && npm test && npm run lint && npm run build`
Expected: all PASS, no new lint errors, build succeeds.

- [ ] **Step 6: Try it in the app**

With bots enabled locally (`AUTO_PLAY_BOTS=true` in `apps/worker/.dev.vars`), run the worker and web dev servers (see `apps/web/README.md`), create a match, **Fill with bots**, and play to 7 marks (or temporarily seed a near-finished match). Check: the dialog opens after the deciding trick's hold; close/reopen works; **Rematch** with three bots moves you straight to a new match with the same seats and a dealt hand, and no toast fires on arrival; readying up for Game 2 of the new match toasts "Game 2 dealt". Check the dialog at phone width.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/Match.tsx apps/web/src/pages/Match.test.tsx
git commit -m "Match: show the match summary, follow a rematch, and cue each new hand

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
