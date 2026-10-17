# Leave game for Custom matches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a seated player leave a dealt Custom match: a parked bot finishes their hand, then the seat shows as open until a person sits down or the others fill it with a bot.

**Architecture:** A new `MatchState.parked?: string[]` marks bots that hold a seat for a person. All "is this seat open?" logic goes through one rules module (`packages/rules/src/parked.ts`); the engine refuses to deal while a seat is parked, `takeSeat` swaps a person into an open parked seat, and the worker, lobby index and both clients read open seats from the same helpers instead of `players.length`.

**Tech Stack:** TypeScript monorepo — `@fortytwo/rules` (pure engine, Vitest), `@fortytwo/worker` (Cloudflare Worker + Durable Objects + D1, Vitest pool-workers), `@fortytwo/client` (shared client logic), `@fortytwo/web` (React, Vitest), `@fortytwo/mobile` (Expo/React Native, Jest).

**Spec:** `docs/superpowers/specs/2026-10-17-leave-custom-game-design.md`

## Global Constraints

- Only `custom` matches gain leaving after the deal. `daily` (Async) still refuses; `live` and `bots` leaving is unchanged.
- `parked` is optional on `MatchState`; absent means none. Stored matches must still read.
- A seat is **open** when it's empty, or held by a parked bot and `gameWinningTeam(match.currentGame) !== null`.
- No hand is dealt while `parked` is non-empty.
- Custom leave drops the match only when no other **human is seated** (bots don't count) — not Live's "present".
- No compatibility work for installed mobile builds; the server keeps the parked bot in `players`.
- Custom confirm copy: "A bot finishes this hand for you, then your seat opens for someone new." / last human: "Nobody else is at the table, so it ends."
- Worker tests: if `vitest-pool-workers` fails to start on Node 26, run them under Node 25 (`nvm use 25.7`).
- Comments match the surrounding code: plain sentences explaining why, at the existing density.

## Review Focus

1. **Two players leave the same hand** — both seats park and open together; the next hand deals only after both are filled. Test in Task 2.
2. **Leaver had already readied up** (left after the hand was decided) — the parked bot must not count as ready, and nothing deals. Test in Task 1.
3. **Everyone else already ready when the newcomer sits** — the next hand deals immediately, opened by the right seat. Test in Task 2.
4. **Leave during the hand that wins the match** — `parked` is cleared, rematch counts the bot as wanting one. Test in Task 1.
5. **The leaver sits back down in their own open seat** — allowed, like anyone; it's a fresh seat (ready, not the bot's id anywhere). Test in Task 2.

---

### Task 1: Rules — parked seats, parking, and the deal guard

**Files:**
- Create: `packages/rules/src/parked.ts`
- Create: `packages/rules/src/parked.test.ts`
- Modify: `packages/rules/src/matchEngine.ts` (`MatchState` near line 82; `patchPlayerReady` ~line 252; match-win in `playDomino` ~line 477)
- Modify: `packages/rules/src/live.ts` (`replaceWithBot`, line 123)
- Modify: `packages/rules/src/index.ts`

**Interfaces:**
- Produces (all exported from `@fortytwo/rules`):
  - `MatchState.parked?: string[]`
  - `renamePlayer(game: Game, fromId: string, toId: string): Game` (in `live.ts`, extracted from `replaceWithBot`, which now uses it)
  - `isParked(match: MatchState, playerId: string): boolean`
  - `openPositions(match: MatchState): number[]` — sorted positions that are empty, or parked with the hand decided
  - `seatedPlayers(match: MatchState): MatchPlayerState[]` — `players` minus those in open positions
  - `parkSeat(match: MatchState, playerId: string): MatchState`

- [ ] **Step 1: Write the failing tests** in `parked.test.ts`, reusing `live.test.ts`'s `deck()` / `dealt('custom')` helpers (copy them) and a `decide(match)` helper that sets the current hand decided the way `live.test.ts`'s `atBreak` does.

```ts
describe('parkSeat', () => {
  it('hands the seat to a parked, unready bot, without a replaced note', () => {
    const match = parkSeat(dealt('custom'), 'p2');
    const bot = match.players.find((p) => p.position === 1)!;
    expect(isBot(bot.playerId)).toBe(true);
    expect(match.parked).toEqual([bot.playerId]);
    expect(bot.ready).toBe(false);
    expect(match.replaced ?? []).not.toContain('p2');
    expect(match.currentGame.hands.some((h) => h.playerId === 'p2')).toBe(false);
  });
  it('unreadies a leaver who had already readied', () => {
    const ready = patchPlayerReady(decide(dealt('custom')), 'p2', true, deck());
    const match = parkSeat(ready, 'p2');
    expect(match.players.find((p) => p.position === 1)!.ready).toBe(false);
  });
});

describe('openPositions', () => {
  it('is the empty seats before the deal', () => {
    expect(openPositions(takeSeat(createMatch('p1', 'custom'), 'p2', 1))).toEqual([2, 3]);
  });
  it('leaves a parked seat taken until the hand is decided, then opens it', () => {
    const parked = parkSeat(dealt('custom'), 'p2');
    expect(openPositions(parked)).toEqual([]);
    expect(seatedPlayers(parked)).toHaveLength(4);
    expect(openPositions(decide(parked))).toEqual([1]);
    expect(seatedPlayers(decide(parked)).map((p) => p.position)).toEqual([0, 2, 3]);
  });
});

describe('patchPlayerReady with a parked seat', () => {
  it('never deals while a seat is parked, even with its ready flag set', () => {
    let match = decide(parkSeat(dealt('custom'), 'p2'));
    // Every seat but p1's marked ready by hand, the parked bot's included.
    match = { ...match, players: match.players.map((p) => ({ ...p, ready: p.playerId !== 'p1' })) };
    const after = patchPlayerReady(match, 'p1', true, deck());
    expect(after.currentGame.id).toBe(match.currentGame.id);
  });
});

describe('winning the match', () => {
  it('clears parked', () => {
    // a match one hand from winning, parked mid-hand, played to the end (as matchEngine.test.ts's
    // match-win tests do)
    expect(wonMatch.winningTeam).not.toBeNull();
    expect(wonMatch.parked).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace @fortytwo/rules -- parked`
Expected: FAIL — `parked.ts` doesn't exist.

- [ ] **Step 3: Implement**
  - `live.ts`: extract `renamePlayer` from `replaceWithBot` (it renames `firstActionBy`, `biddingPlayerId`, `currentPlayerId`, hands, tricks, `currentTrick`); `replaceWithBot` calls it. Existing `live.test.ts` stays green.
  - `matchEngine.ts`: add `parked?: string[]` to `MatchState` with a one-line comment; in `patchPlayerReady`, don't enter the deal branch while `(match.parked ?? []).length > 0`; where `playDomino` sets `matchWinningTeam`, drop `parked` from the result when the match is won (alongside `letClaimsGo`).
  - `parked.ts`: `parkSeat` = `replaceWithBot`, then add the bot id to `parked`, set its seat `ready: false`, and remove `playerId` from the `replaced` it appended. `openPositions` / `seatedPlayers` / `isParked` per the Interfaces block.
  - `index.ts`: export the new names.

- [ ] **Step 4: Run to verify they pass, and the whole package**

Run: `npm test --workspace @fortytwo/rules && npm run typecheck --workspace @fortytwo/rules`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/rules
git commit -m "feat(rules): park a leaver's seat in a Custom match"
```

### Task 2: Rules — taking an open parked seat, and unparking

**Files:**
- Modify: `packages/rules/src/parked.ts`, `packages/rules/src/parked.test.ts`
- Modify: `packages/rules/src/matchEngine.ts` (`takeSeat`, line 174)
- Modify: `packages/rules/src/index.ts`

**Interfaces:**
- Consumes: Task 1's `parkSeat`, `openPositions`, `renamePlayer`.
- Produces:
  - `takeSeat(match, playerId, position, dealOrder?)` — unchanged signature; at an open parked position it calls `takeParkedSeat`.
  - `takeParkedSeat(match: MatchState, playerId: string, position: number, dealOrder: Domino[]): MatchState`
  - `unpark(match: MatchState, positions?: number[]): MatchState` — removes the parked bots at `positions` (or every open parked seat when omitted) from `parked`; the bots stay seated.

- [ ] **Step 1: Write the failing tests**

```ts
describe('takeSeat at a parked seat', () => {
  it('swaps the person in, ready, and renames the bot everywhere', () => {
    const open = decide(parkSeat(dealt('custom'), 'p2'));
    const botId = open.parked![0];
    const match = takeSeat(open, 'p5', 1, deck());
    expect(match.players.find((p) => p.position === 1)).toMatchObject({ playerId: 'p5', ready: true });
    expect(match.parked ?? []).toEqual([]);
    expect(JSON.stringify(match.currentGame)).not.toContain(botId);
  });
  it('deals at once when the other three are already ready, opened by the seat after the last opener', () => {
    let open = decide(parkSeat(dealt('custom'), 'p2'));
    for (const id of ['p1', 'p3', 'p4']) open = patchPlayerReady(open, id, true, deck());
    const lastOpenerPosition = open.players.find((p) => p.playerId === open.currentGame.firstActionBy)!.position;
    const match = takeSeat(open, 'p5', 1, deck());
    expect(match.currentGame.id).not.toBe(open.currentGame.id);
    expect(match.players.find((p) => p.playerId === match.currentGame.firstActionBy)!.position).toBe((lastOpenerPosition + 1) % 4);
  });
  it('waits for the others otherwise', () => {
    const open = decide(parkSeat(dealt('custom'), 'p2'));
    expect(takeSeat(open, 'p5', 1, deck()).currentGame.id).toBe(open.currentGame.id);
  });
  it('refuses a parked seat whose hand is not decided yet', () => {
    expect(() => takeSeat(parkSeat(dealt('custom'), 'p2'), 'p5', 1, deck())).toThrow(ValidationError);
  });
  it('lets the leaver sit back down', () => {
    const match = takeSeat(decide(parkSeat(dealt('custom'), 'p2')), 'p2', 1, deck());
    expect(match.players.find((p) => p.position === 1)).toMatchObject({ playerId: 'p2', ready: true });
  });
  it('needs both seats filled when two players left the same hand', () => {
    let open = decide(parkSeat(parkSeat(dealt('custom'), 'p2'), 'p4'));
    expect(openPositions(open)).toEqual([1, 3]);
    open = patchPlayerReady(open, 'p1', true, deck());
    open = patchPlayerReady(open, 'p3', true, deck());
    const one = takeSeat(open, 'p5', 1, deck());
    expect(one.currentGame.id).toBe(open.currentGame.id);
    expect(takeSeat(one, 'p6', 3, deck()).currentGame.id).not.toBe(open.currentGame.id);
  });
});

describe('unpark', () => {
  it('keeps the bot and lets it ready up like any bot', () => {
    const open = decide(parkSeat(dealt('custom'), 'p2'));
    const match = unpark(open);
    expect(match.parked ?? []).toEqual([]);
    expect(openPositions(match)).toEqual([]);
    expect(isBot(match.players.find((p) => p.position === 1)!.playerId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace @fortytwo/rules -- parked`
Expected: FAIL — `takeSeat` throws "Match is full" on the parked seat; `unpark` undefined.

- [ ] **Step 3: Implement**
  - `takeSeat`: before `assertNotFull`, if `position` is in `openPositions(match)` and held by a parked bot, `assertActive`, `assertIsNotMatchPlayer`, then return `takeParkedSeat(match, playerId, position, dealOrder)`; a missing `dealOrder` there is a programming error (`throw new Error`) — the route always sends one. A parked seat not yet open falls through to the existing checks, which refuse it as taken.
  - `takeParkedSeat`: rename the bot's id to `playerId` in `players` and via `renamePlayer` in `currentGame`, set the seat `ready: true`, drop the bot from `parked`, then return `patchPlayerReady(swapped, playerId, true, dealOrder)` so the deal runs when everyone is ready.
  - `unpark`: per Interfaces.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test --workspace @fortytwo/rules && npm run typecheck --workspace @fortytwo/rules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rules
git commit -m "feat(rules): take or fill an open parked seat"
```

### Task 3: Worker — bots, leaving and Fill with bots

**Files:**
- Modify: `apps/worker/src/bots.ts` (`findNextBotAction`, line 81)
- Modify: `apps/worker/src/bots.test.ts`
- Modify: `apps/worker/src/matchDO.ts` (`leave`, line 206; `addBots`, line 254)
- Create: `apps/worker/test/matchDOLeaveCustom.test.ts`

**Interfaces:**
- Consumes: `parkSeat`, `unpark`, `isParked`, `openPositions`, `hasHumanPlayers` from `@fortytwo/rules`.
- Produces: `MatchDO.leave` handles dealt `custom` matches; `MatchDO.addBots` unparks open parked seats.

- [ ] **Step 1: Write the failing tests**

`bots.test.ts`:
```ts
describe('findNextBotAction with a parked bot', () => {
  it('plays its turns, plays out leftovers once the hand is decided, and never readies', () => {
    // parked mid-hand on its turn -> { kind: 'play' | 'bid' ... , playerId: botId }
    // decided, bot holds dominoes and it's its turn -> { kind: 'play', playerId: botId }
    // decided, bot holds none, other bots ready -> null (never { kind: 'ready', playerId: botId })
  });
});
```

`matchDOLeaveCustom.test.ts` (helpers `stubFor`, `stored`, `decideHand`, `lobbySeats` copied from `matchDOTakeover.test.ts`; a `dealtCustom(name)` helper creates the match with `stub.create('p1', name)` and seats p2–p4 with `takeSeat`, syncing the lobby with `syncLobbyIndex`):

```ts
it('parks the seat mid-hand; the bot finishes the hand and then waits unready', ...)
  // leave('p2') -> parked has the bot at position 1; runDurableObjectAlarm plays its turns;
  // after decideHand(stub, () => true except the bot), firing the alarm leaves the bot unready
  // and currentGame.id unchanged.
it('drops the match when no other human is seated, even if they are offline', ...)
  // p2..p4 are bots via addBots; leave('p1') -> { deleted: true }
it('keeps the match when the others are seated but not connected', ...)
  // no sockets open; leave('p2') -> { deleted: false }
it('opens the seat at once when the hand is already decided', ...)
  // decideHand first; leave('p2'); openPositions(stored) -> [1]
it('still refuses an Async match after the deal', ...)
  // create with mode 'daily' -> leave after deal is { ok: false, status: 400 }
it('Fill with bots unparks the open seat and the next hand deals', ...)
  // after the seat opens and p1,p3,p4 ready: addBots('p1') -> parked empty; fire alarm -> new currentGame.id
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace @fortytwo/worker -- bots matchDOLeaveCustom`
Expected: FAIL — Custom leave after the deal is refused ("You can't leave once the dominoes are dealt").

- [ ] **Step 3: Implement**
  - `findNextBotAction`: the "waiting bot readies up" lookup skips `isParked(match, p.playerId)`.
  - `MatchDO.leave`: after the claims branch, for `custom` with `hasBeenDealt(match) && match.winningTeam === null`: `assertIsMatchPlayer`; if no other seated human (`!match.players.some((p) => p.playerId !== playerId && !isBot(p.playerId))`), `drop`; else `parkSeat`, save, `publish`, `schedule`, return `{ deleted: false, match: next }`. Update the method's comment. `daily` keeps falling through to `removePlayer`'s refusal.
  - `MatchDO.addBots`: `unpark(match, positions)` first, then `seatBots` on the positions still empty (none when the only open seat was parked).

- [ ] **Step 4: Run to verify they pass, plus the existing leave/takeover/bots suites**

Run: `npm test --workspace @fortytwo/worker -- bots matchDOLeave matchDOTakeover matchDOBots`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): leave a Custom game under way"
```

### Task 4: Worker — lobby index and invites see the open seat

**Files:**
- Modify: `apps/worker/src/lobby.ts` (`syncLobbyIndex` line 46, `refreshMatchSummary` line 68)
- Modify: `apps/worker/src/routes/matches.ts` (`POST /:id/invites`, line 170)
- Modify: `apps/worker/test/matchDOLeaveCustom.test.ts`, `apps/worker/test/routes.invites.test.ts`

**Interfaces:**
- Consumes: `seatedPlayers` from `@fortytwo/rules`.
- Produces: lobby `player_count` and `match_players` count only seated (non-open) seats; invites accepted at a table with an open seat.

- [ ] **Step 1: Write the failing tests**

```ts
it('player_count drops to 3 when a human play decides the hand, and back to 4 on sit-down', ...)
  // through the routes (SELF.fetch POST /api/matches/:id/games/current/moves), as routes.matches.test.ts does
it('player_count drops to 3 when a bot play decides the hand', ...)
  // the parked bot plays the deciding domino via runDurableObjectAlarm
it('invites can be sent at the break, survive until someone sits, and list for the invitee', ...)
  // routes.invites.test.ts: POST /:id/invites at an open parked seat -> 200 { invited: ['p5'] };
  // GET /api/invites as p5 -> one invite with seatsOpen: 1; p5 takes the seat -> invites row gone
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace @fortytwo/worker -- matchDOLeaveCustom routes.invites`
Expected: FAIL — `player_count` stays 4; invites route answers 409 "Table is full".

- [ ] **Step 3: Implement**
  - `lobby.ts`: `syncLobbyIndex` and `refreshMatchSummary` use `seatedPlayers(match)` for `playerCount` and for the players passed to `syncMatchPlayers`. `refreshMatchSummary` already rewrites `player_count` when it changes, and both play paths (the moves route's `lobbySync: 'summary'`, the alarm's refresh after a `play`) call it, so the seat opening is synced without a new hook.
  - `routes/matches.ts`: the invites route's full check uses `seatedPlayers(match).length >= 4`.

- [ ] **Step 4: Run to verify they pass, plus the lobby suites**

Run: `npm test --workspace @fortytwo/worker && npm run typecheck --workspace @fortytwo/worker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): list and invite to an open parked seat"
```

### Task 5: Client package — open seats in the shared view

**Files:**
- Modify: `packages/client/src/table.ts` (`openSeats`, line 22), `packages/client/src/table.test.ts`
- Modify: `packages/client/src/matchView.ts` (`MatchView`, line 67; `describeMatch`, line 95), `packages/client/src/matchView.test.ts`

**Interfaces:**
- Consumes: `openPositions` from `@fortytwo/rules`.
- Produces:
  - `openSeats(match: MatchState, myPlayerId: string): { position: number; seat: Seat }[]` — signature changes from `players` to `match`; lists open positions (empty or open parked).
  - `MatchView.openSeatCount: number`

- [ ] **Step 1: Write the failing tests**

```ts
it('lists an open parked seat', () => {
  expect(openSeats(openParkedMatch, 'p1')).toEqual([{ position: 1, seat: 'left' }]);
});
it('does not list a parked seat whose hand is still being played', () => {
  expect(openSeats(parkedMidHand, 'p1')).toEqual([]);
});
it('counts open seats in the view', () => {
  expect(describeMatch(openParkedMatch, 'p1').openSeatCount).toBe(1);
});
```
(Update the two existing `openSeats` tests to pass a match.)

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace @fortytwo/client`
Expected: FAIL.

- [ ] **Step 3: Implement** `openSeats` from `openPositions(match)`; `openSeatCount = openPositions(match).length`. Update the two callers (`apps/web/src/pages/Match.tsx:644`, `apps/mobile/src/app/match/[id].tsx:566`) to pass `match` so everything typechecks.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test --workspace @fortytwo/client && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client apps/web/src/pages/Match.tsx "apps/mobile/src/app/match/[id].tsx"
git commit -m "feat(client): treat an open parked seat as empty"
```

### Task 6: Web — Leave game and the open seat at the break

**Files:**
- Modify: `apps/web/src/pages/Match.tsx` (leave button ~line 802; seat names ~line 510; table seats; waiting panel ~line 888)
- Modify: `apps/web/src/pages/Match.test.tsx`

**Interfaces:**
- Consumes: `openSeats(match, id)`, `view.openSeatCount`, `openPositions`.

- [ ] **Step 1: Write the failing tests**

```ts
it('offers Leave in a dealt Custom match, with the Custom confirm', ...)
  // confirm called with 'Leave this game? A bot finishes this hand for you, then your seat opens for someone new.'
it('says the game ends when nobody else is seated', ...)
  // 'Leave this game? Nobody else is at the table, so it ends.'
it('shows an open parked seat as empty, with Share link and Invite players, at the break', ...)
it('shows Fill with bots there when bots are on', ...)
it('tells the seated players the next hand waits for the seat to be filled', ...)
  // text 'Waiting for a player' (or the builder's chosen copy) in the hand-over area
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace @fortytwo/web -- Match`
Expected: FAIL.

- [ ] **Step 3: Implement**
  - Leave button condition gains `mode === 'custom'`; the outcome text for Custom uses `onlyHumanSeated` and the Global Constraints copy; Live/Bots keep `lastPresent`.
  - Seat names, the seat picker and the table draw an open parked position as empty (via `openPositions`).
  - The waiting panel's invite buttons (Share link, Invite players, Fill with bots) and `N of 4 seated` show when `view.openSeatCount > 0` as well as before the deal; the pre-deal Leave table / Cancel match button stays tied to `!hasBeenDealt(match)`.
  - The hand-over panel says the hand waits for the open seat; layout is yours.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test --workspace @fortytwo/web && npm run typecheck --workspace @fortytwo/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): leave a Custom game under way"
```

### Task 7: Mobile — Leave game and the open seat at the break

**Files:**
- Modify: `apps/mobile/src/app/match/[id].tsx` (`canLeaveGame` line 587; `confirmLeaveGame` line 590; seat names line 436; table seats line 564; waiting panel line 716)
- Modify: `apps/mobile/src/match/__tests__/matchScreen.test.tsx`

**Interfaces:**
- Consumes: as Task 6.

- [ ] **Step 1: Write the failing tests** — the same five cases as Task 6, against the match screen: the ⋮ menu shows **Leave game** for a dealt Custom match; `Alert.alert` is called with `'Leave this game?'` and the Custom message (or the last-human one); the open parked seat renders empty with **Share link** / **Invite players** (and **Fill with bots** when `config.bots`); the waiting-for-a-player message shows.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test --workspace @fortytwo/mobile -- matchScreen`
Expected: FAIL.

- [ ] **Step 3: Implement** the same changes as Task 6 in the mobile screen: `canLeaveGame` adds `mode === 'custom'`; the confirm message picks Custom copy by mode; open parked seats render empty; the waiting buttons show when `view.openSeatCount > 0`. Don't run `expo lint` (it rewrites the lockfile).

- [ ] **Step 4: Run to verify they pass**

Run: `npm test --workspace @fortytwo/mobile && npm run typecheck --workspace @fortytwo/mobile`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): leave a Custom game under way"
```
