# Over the table and seat takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename Live to "Over the table" in everything players see, and let players take over bot seats in games under way, with away players replaced by bots and empty-of-humans tables dropped.

**Architecture:** All seat rules are pure functions in `@fortytwo/rules` (`live.ts`, `matchEngine.ts`, `stats.ts`). The Worker's `MatchDO` runs them and its single alarm acts on `liveDeadline`; the `Matchmaker` DO keeps dealt `live` tables on its list and asks them for a claim. Clients get small shared helpers in `@fortytwo/client`'s `live.ts` and show a watch-only table to a claimant.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects + D1, Hono, Vitest (`@cloudflare/vitest-pool-workers` for the Worker), React (web), React Native/Expo + Jest (mobile).

**Spec:** `docs/superpowers/specs/2026-10-11-matchmaking-design.md` (sections **Seat takeover**, **Leaving and dropped matches**, **Live timers**, **Stats**, **Clients**).

## Global Constraints

- The mode value stays `'live'` everywhere in code, storage, D1 and the API. Only player-facing text says **Over the table**.
- New `MatchState` / `Game` / `Hand` fields are optional; matches stored before this change must still load and behave as before.
- `LIVE_ABANDON_MS = 120_000`, `TAKEOVER_MAX_MARKS = 5`, `MIN_HANDS_FOR_RESULT = 3`, all exported from `@fortytwo/rules`.
- Claims only ever take **bot** seats; claims never outnumber bot seats.
- The last present human (seated, not a bot, not on autopilot) is never put on autopilot.
- Daily and custom matches are untouched by every rule in this plan.
- Comments follow the repo's style: plain sentences explaining why, no ticket numbers.
- Commit messages are conventional (`feat(rules): ...`, `feat(worker): ...`, `feat(web): ...`, `feat(mobile): ...`) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worker tests run under Node 25 if Node 26 fails (`nvm use 25.7`).

## Review Focus

1. **The opener after a seat swap.** A hand break where the last opener's seat changed hands must still deal with the next seat opening; `patchPlayerReady` used to look the opener up by id and would crash. Pinned in Task 4.
2. **Leave game mid-trick.** A player leaving while the current trick holds their domino, or while they're the high bidder, must leave a bot that can carry on (ids renamed everywhere in `currentGame`). Pinned in Task 3.
3. **Claimant pressing Over the table again** after the table dropped off the Matchmaker's list (its bot seats are all claimed) must go back to the same match, not a second one. Pinned in Task 9.
4. **Drop while someone watches.** A dropped table must tell its claimants (`bumped`) before the sockets close, and their clients must search again instead of showing "This match was deleted". Pinned in Tasks 7 and 11.
5. **Old stored matches.** A match saved before this change (no `dealtOn`, `awaySince`, `hadBots`, `autoBid`) must not have anyone replaced at its next break, and its stats must count every hand. Pinned in Tasks 4 and 5.

---

### Task 1: Rename Live to Over the table in player-facing text

**Files:**
- Modify: `cloudflare/packages/client/src/lobby.ts:18`
- Modify: `cloudflare/apps/web/src/components/NewMatchDialog.tsx:24`
- Modify: `cloudflare/apps/mobile/src/components/NewMatchSheet.tsx:26`
- Modify: `cloudflare/apps/mobile/src/app/index.tsx:29`
- Modify: `cloudflare/apps/web/src/pages/Match.tsx:700-717` and `cloudflare/apps/mobile/src/app/match/[id].tsx` (the matching "Finding players…" block)
- Test: `cloudflare/packages/client/src/lobby.test.ts`, `cloudflare/apps/web/src/components/NewMatchDialog.test.tsx`, `cloudflare/apps/mobile/src/components/__tests__/components.test.tsx`

**Interfaces:**
- Produces: `MODE_LABELS.live === 'Over the table'`.

- [ ] **Step 1: Find every player-facing "Live"**

Run: `cd cloudflare && grep -rn "Live" apps/web/src apps/mobile/src packages/client/src --include=*.tsx --include=*.ts | grep -v "^\S*:\s*//" | grep -v test`
Expected: the chooser titles, `MODE_LABELS`, the mobile empty state, and any web empty state. Comments may keep saying Live.

- [ ] **Step 2: Update the tests first**

In `lobby.test.ts`, change any expectation of `'Live'` from `MODE_LABELS`/`rowStatus` to `'Over the table'`. In `NewMatchDialog.test.tsx` and the mobile `components.test.tsx`, change `getByText('Live')` (or the role query by name) to `'Over the table'`, and add:

```tsx
expect(screen.getByText(/new players take over bots' seats between hands/)).toBeInTheDocument();
```

(mobile: `expect(getByText(/new players take over bots' seats between hands/)).toBeTruthy();`)

- [ ] **Step 3: Run them to see them fail**

Run: `cd cloudflare && npm test -w @fortytwo/client && npm test -w apps/web -- NewMatchDialog && npm test -w apps/mobile -- components`
Expected: FAIL on the new text.

- [ ] **Step 4: Change the text**

`lobby.ts`:
```ts
export const MODE_LABELS: Record<MatchMode, string> = { live: 'Over the table', daily: 'Daily', custom: 'Custom' };
```

Both choosers (web `icon: 'oi-bolt'`, mobile `icon: 'flash'` unchanged):
```ts
{
  choice: 'live',
  title: 'Over the table',
  detail: "Play now with whoever's online. Bots fill empty seats after 2½ min, or start with bots any time. 60-second turns; new players take over bots' seats between hands.",
  icon: 'oi-bolt',
},
```

Mobile empty state: `'Start a new match: play over the table now, take Daily turns, or challenge friends.'` (and the web one if Step 1 found it).

Search screen, web `Match.tsx` after the `table-presence` line (mobile: same text in a `Text` with the presence line's style):
```tsx
<p className="table-presence">Bots take the empty seats at {formatClock(LIVE_FILL_MS)}. Players can still join after you start.</p>
```
Import `LIVE_FILL_MS` from `@fortytwo/rules`.

- [ ] **Step 5: Run the tests to see them pass**

Run the Step 3 command. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A cloudflare/packages/client cloudflare/apps/web/src cloudflare/apps/mobile/src
git commit -m "feat(web): call Live 'Over the table' and say how it works"
```

---

### Task 2: Rules state - `dealtOn`, `awaySince`, `hadBots`, new constants

**Files:**
- Modify: `cloudflare/packages/rules/src/game.ts` (Game)
- Modify: `cloudflare/packages/rules/src/hand.ts` (Hand)
- Modify: `cloudflare/packages/rules/src/matchEngine.ts` (MatchState, `seatPlayer`, `patchPlayerReady`, `createRematch`)
- Modify: `cloudflare/packages/rules/src/live.ts` (`setAutopilot`, constants)
- Modify: `cloudflare/packages/rules/src/index.ts` (exports)
- Test: `cloudflare/packages/rules/src/live.test.ts`

**Interfaces:**
- Produces:
  - `Game.dealtOn?: string`, set whenever hands are dealt.
  - `Hand.autoBid?: true` (type only here; set in Task 5).
  - `MatchState.claims?: string[]`, `awaySince?: Record<string, string>`, `hadBots?: boolean`, `replaced?: string[]`, `bumped?: string[]`.
  - `LIVE_ABANDON_MS = 120_000`, `TAKEOVER_MAX_MARKS = 5` in `live.ts`.
  - `setAutopilot` writes `awaySince[id] = now` on and deletes it off.
  - `isPresent(match, playerId): boolean` - seated, not a bot, not on autopilot.

- [ ] **Step 1: Write the failing tests** (append to `live.test.ts`)

```ts
describe('seat bookkeeping', () => {
  it('stamps a hand with when it was dealt', () => {
    expect(dealt().currentGame.dealtOn).toEqual(expect.any(String));
  });

  it('records when a player went away, and forgets it when they come back', () => {
    const away = setAutopilot(dealt(), ['p2'], true);
    expect(away.awaySince?.p2).toEqual(expect.any(String));
    expect(setAutopilot(away, ['p2'], false).awaySince?.p2).toBeUndefined();
  });

  it('remembers that a bot ever sat down', () => {
    let match = createMatch('p1', 'live');
    match = takeSeat(match, 'bot-1', 1);
    expect(match.hadBots).toBe(true);
    expect(createMatch('p1', 'live').hadBots).toBeUndefined();
  });

  it('counts only seated humans not on autopilot as present', () => {
    let match = createMatch('p1', 'live');
    match = takeSeat(match, 'p2', 1);
    match = takeSeat(match, 'bot-1', 2);
    match = takeSeat(match, 'p4', 3, deck());
    match = setAutopilot(match, ['p4'], true);
    expect(isPresent(match, 'p1')).toBe(true);
    expect(isPresent(match, 'bot-1')).toBe(false);
    expect(isPresent(match, 'p4')).toBe(false);
    expect(isPresent(match, 'stranger')).toBe(false);
  });
});
```

Add `isPresent` to the `./live` import.

- [ ] **Step 2: Run to see it fail**

Run: `cd cloudflare && npm test -w @fortytwo/rules -- live`
Expected: FAIL (`isPresent` not exported; `dealtOn`/`awaySince`/`hadBots` undefined).

- [ ] **Step 3: Implement**

`game.ts`, in `Game`:
```ts
  // When the hand was dealt; absent on hands from before it was recorded. A player on autopilot
  // since then has been away for the whole hand (live.ts).
  dealtOn?: string;
```

`hand.ts`, in `Hand`:
```ts
  // The bot made this seat's bid or trump call for a player on autopilot, so the hand isn't
  // theirs for stats (stats.ts).
  autoBid?: true;
```

`matchEngine.ts`, in `MatchState` after `autopilot`:
```ts
  // When each player on autopilot went away, written and cleared with `autopilot` (live.ts).
  awaySince?: Record<string, string>;
  // Players waiting to take a bot's seat at the next hand break, in the order they asked.
  claims?: string[];
  // A bot has sat at this table at some point, so its stats count as a bots game even after
  // people have taken every bot's seat.
  hadBots?: boolean;
  // Players whose seat a bot took after they were away a whole hand, or who left.
  replaced?: string[];
  // Claimants let go without a seat (the match ended or was dropped first); their app searches again.
  bumped?: string[];
```

`seatPlayer`: set `dealtOn` when it deals, `hadBots` when a bot sits:
```ts
  if (currentGame.hands.length === 4 && dealOrder) {
    currentGame = { ...currentGame, hands: dealHands(currentGame.hands, players, dealOrder), dealtOn: now() };
    players = players.map((p) => ({ ...p, ready: false }));
  }

  return { ...match, currentGame, players, updatedOn: now(), ...(isBot(playerId) ? { hadBots: true } : {}) };
```

`patchPlayerReady`: add `dealtOn: now(),` to the new `currentGame` literal. `createRematch`: add `dealtOn: timestamp,` to its `currentGame`, and `...(players.some((p) => isBot(p.playerId)) ? { hadBots: true } : {}),` to the returned match.

`live.ts`:
```ts
// How long a table whose last present player has run out their turn waits for them before it's
// dropped. Bots don't play on meanwhile - nobody would be watching.
export const LIVE_ABANDON_MS = 120_000;
// Newcomers can't claim a seat once either team has this many marks: they'd join for a hand or two.
export const TAKEOVER_MAX_MARKS = 5;

// At the table and playing: seated, a person, and not on autopilot.
export function isPresent(match: MatchState, playerId: string): boolean {
  return match.players.some((p) => p.playerId === playerId) && !isBot(playerId) && !isOnAutopilot(match, playerId);
}

export function setAutopilot(match: MatchState, playerIds: string[], on: boolean): MatchState {
  const ids = new Set(match.autopilot ?? []);
  const awaySince = { ...match.awaySince };
  const at = new Date().toISOString();
  for (const id of playerIds) {
    if (on) {
      if (!ids.has(id)) awaySince[id] = at;
      ids.add(id);
    } else {
      ids.delete(id);
      delete awaySince[id];
    }
  }
  return { ...match, autopilot: [...ids], awaySince };
}
```

`index.ts`: add `LIVE_ABANDON_MS`, `TAKEOVER_MAX_MARKS`, `isPresent` to the existing `./live` export list.

- [ ] **Step 4: Run to see it pass, plus the whole package**

Run: `cd cloudflare && npm test -w @fortytwo/rules && npm run typecheck -w @fortytwo/rules`
Expected: PASS. (Existing tests compare `autopilot` only, so the extra `awaySince` key doesn't break them; fix any `toEqual` on a whole match by adding `awaySince` if one does.)

- [ ] **Step 5: Commit**

```bash
git add cloudflare/packages/rules
git commit -m "feat(rules): record when hands are dealt, when players went away, and whether bots sat in"
```

---

### Task 3: Rules - `replaceWithBot`

**Files:**
- Modify: `cloudflare/packages/rules/src/live.ts`
- Modify: `cloudflare/packages/rules/src/index.ts`
- Test: `cloudflare/packages/rules/src/live.test.ts`

**Interfaces:**
- Consumes: `BOT_IDS`, `isBot` (`botIds.ts`), `setAutopilot` (Task 2).
- Produces: `replaceWithBot(match: MatchState, playerId: string): MatchState` - the seat goes to the first free `BOT_IDS` entry with position, readiness and current hand kept; every id in `currentGame` that names the player is renamed; the player leaves `autopilot`/`awaySince` and joins `replaced`; sets `hadBots`. Throws `ValidationError` if the player isn't seated or no bot id is free.

- [ ] **Step 1: Write the failing tests**

```ts
import { placeBid, setTrump, playDomino } from './matchEngine';
import { Bid } from './bid';
import { Suit } from './suit';

describe('replaceWithBot', () => {
  it('hands the seat, its hand and its turn to a free bot', () => {
    const match = dealt();
    const next = replaceWithBot(match, 'p1');
    const bot = next.players.find((p) => p.position === 0)!;
    expect(bot.playerId).toBe('bot-1');
    expect(next.currentGame.hands.find((h) => h.playerId === 'bot-1')!.dominoes).toEqual(
      match.currentGame.hands.find((h) => h.playerId === 'p1')!.dominoes
    );
    expect(next.currentGame.currentPlayerId).toBe('bot-1');
    expect(next.currentGame.firstActionBy).toBe('bot-1');
    expect(next.replaced).toEqual(['p1']);
    expect(next.hadBots).toBe(true);
  });

  it('renames a high bidder and a trick winner mid-hand, so play can carry on', () => {
    let match = dealt();
    match = placeBid(match, 'p1', Bid.Thirty);
    for (const id of ['p2', 'p3', 'p4']) match = placeBid(match, id, Bid.Pass);
    match = setTrump(match, 'p1', Suit.Sixes);
    const next = replaceWithBot(match, 'p1');
    expect(next.currentGame.biddingPlayerId).toBe('bot-1');
    expect(next.currentGame.currentPlayerId).toBe('bot-1');
    const lead = next.currentGame.hands.find((h) => h.playerId === 'bot-1')!.dominoes[0];
    expect(() => playDomino(next, 'bot-1', lead)).not.toThrow();
  });

  it('takes the player off autopilot and picks the next free bot id', () => {
    let match = createMatch('p1', 'live');
    match = takeSeat(match, 'bot-1', 1);
    match = takeSeat(match, 'p3', 2);
    match = takeSeat(match, 'p4', 3, deck());
    match = setAutopilot(match, ['p3'], true);
    const next = replaceWithBot(match, 'p3');
    expect(next.players.find((p) => p.position === 2)!.playerId).toBe('bot-2');
    expect(next.autopilot).toEqual([]);
    expect(next.awaySince?.p3).toBeUndefined();
  });

  it('refuses someone not at the table', () => {
    expect(() => replaceWithBot(dealt(), 'stranger')).toThrow(ValidationError);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd cloudflare && npm test -w @fortytwo/rules -- live`
Expected: FAIL (`replaceWithBot` not exported).

- [ ] **Step 3: Implement** (in `live.ts`; add `BOT_IDS` to the `./botIds` import, `ValidationError` from `./errors`, `Game` type from `./game`)

```ts
// A bot takes a player's seat for good: when they leave an Over the table game, or were away for
// a whole hand. Mid-hand the bot picks up their hand, bid and turn, so every id in the hand that
// names them is renamed. Hands already filed keep the player's id.
export function replaceWithBot(match: MatchState, playerId: string): MatchState {
  assertIsMatchPlayer(match, playerId);
  const botId = BOT_IDS.find((id) => match.players.every((p) => p.playerId !== id));
  if (botId === undefined) throw new ValidationError('No bot free to take the seat');

  const rename = (id: string | null) => (id === playerId ? botId : id);
  const game = match.currentGame;
  const currentGame: Game = {
    ...game,
    firstActionBy: rename(game.firstActionBy),
    biddingPlayerId: rename(game.biddingPlayerId),
    currentPlayerId: rename(game.currentPlayerId),
    hands: game.hands.map((h) => (h.playerId === playerId ? { ...h, playerId: botId } : h)),
    tricks: game.tricks.map((t) => ({ ...t, playerId: rename(t.playerId) })),
    currentTrick: { ...game.currentTrick, playerId: rename(game.currentTrick.playerId) },
  };
  const off = setAutopilot(match, [playerId], false);
  return {
    ...off,
    autopilot: off.autopilot!.filter((id) => id !== playerId),
    players: match.players.map((p) => (p.playerId === playerId ? { ...p, playerId: botId } : p)),
    currentGame,
    replaced: [...(match.replaced ?? []), playerId],
    hadBots: true,
    updatedOn: new Date().toISOString(),
  };
}
```

Export `replaceWithBot` from `index.ts`.

- [ ] **Step 4: Run to see it pass**

Run: `cd cloudflare && npm test -w @fortytwo/rules -- live`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare/packages/rules
git commit -m "feat(rules): let a bot take over a player's seat, mid-hand included"
```

---

### Task 4: Rules - claims and the hand break

**Files:**
- Modify: `cloudflare/packages/rules/src/live.ts` (`claimSeat`, `releaseClaim`, `seatChangesAtBreak`)
- Modify: `cloudflare/packages/rules/src/matchEngine.ts` (`patchPlayerReady`, `playDomino`)
- Modify: `cloudflare/packages/rules/src/index.ts`
- Test: `cloudflare/packages/rules/src/live.test.ts`

**Interfaces:**
- Consumes: `replaceWithBot` (Task 3), `dealtOn`/`awaySince` (Task 2), `matchScores`, `hasBeenDealt`.
- Produces:
  - `claimSeat(match, playerId): MatchState` - refuses (ValidationError) unless `live`, dealt, unfinished, both teams `< TAKEOVER_MAX_MARKS`, player not seated or claiming, and `claims.length < botSeats`.
  - `releaseClaim(match, playerId): MatchState` - no-op if not claiming.
  - `isAwayAllHand(match, playerId): boolean`.
  - `patchPlayerReady`, on dealing in a `live` match: replaces players away for the whole hand, seats claims in bot seats (lowest position first), works the opener out by position.
  - `playDomino`, when it wins the match: moves `claims` into `bumped`.

- [ ] **Step 1: Write the failing tests**

```ts
import { patchPlayerReady, WINNING_SCORE } from './matchEngine';
import { Teams } from './teams';

// p1 and p3 against bot-1 and bot-2, dealt.
function withBots(): MatchState {
  let match = createMatch('p1', 'live');
  match = takeSeat(match, 'bot-1', 1);
  match = takeSeat(match, 'p3', 2);
  return takeSeat(match, 'bot-2', 3, deck());
}

// A filed hand worth one mark: p1 bid 30.
function markHand(match: MatchState): Game {
  return {
    ...match.currentGame,
    biddingPlayerId: 'p1',
    bid: Bid.Thirty,
    hands: match.currentGame.hands.map((h) => (h.playerId === 'p1' ? { ...h, bid: Bid.Thirty } : h)),
  };
}

// The current hand decided and everyone but `last` ready, so `last` readying deals the next one.
// Seat 0 bid 30; seat 1's team took one trick of 31 points, more than the 12 that sets the bid.
function atBreak(match: MatchState, last: string): MatchState {
  const bidder = match.players.find((p) => p.position === 0)!.playerId;
  const setter = match.players.find((p) => p.position === 1)!.playerId;
  const counts = [createDomino(5, 5), createDomino(6, 4), createDomino(5, 0), createDomino(4, 1)];
  const decided = {
    ...match,
    currentGame: {
      ...match.currentGame,
      biddingPlayerId: bidder,
      bid: Bid.Thirty,
      trump: Suit.Sixes,
      tricks: [{ playerId: setter, team: Teams.TeamB, suit: Suit.Sixes, dominoes: counts }],
    },
  };
  return { ...decided, players: decided.players.map((p) => ({ ...p, ready: p.playerId !== last })) };
}

describe('claimSeat', () => {
  it('queues a newcomer for a bot seat', () => {
    expect(claimSeat(withBots(), 'n1').claims).toEqual(['n1']);
  });

  it('allows no more claims than bot seats', () => {
    const two = claimSeat(claimSeat(withBots(), 'n1'), 'n2');
    expect(() => claimSeat(two, 'n3')).toThrow(ValidationError);
  });

  it('refuses outside Over the table, before the deal, once finished, near the end, and twice', () => {
    expect(() => claimSeat({ ...withBots(), mode: 'daily' }, 'n1')).toThrow(ValidationError);
    expect(() => claimSeat(createMatch('p1', 'live'), 'n1')).toThrow(ValidationError);
    expect(() => claimSeat({ ...withBots(), winningTeam: Teams.TeamA }, 'n1')).toThrow(ValidationError);
    const nearEnd = { ...withBots(), games: { [Teams.TeamA]: Array.from({ length: TAKEOVER_MAX_MARKS }, () => markHand(withBots())) } };
    expect(() => claimSeat(nearEnd, 'n1')).toThrow(ValidationError);
    expect(() => claimSeat(claimSeat(withBots(), 'n1'), 'n1')).toThrow(ValidationError);
    expect(() => claimSeat(withBots(), 'p1')).toThrow(ValidationError);
  });

  it('lets a claim go', () => {
    expect(releaseClaim(claimSeat(withBots(), 'n1'), 'n1').claims).toEqual([]);
  });
});

describe('the hand break', () => {
  it('seats claims in bot seats, lowest position first, ready for the deal', () => {
    const match = atBreak(claimSeat(withBots(), 'n1'), 'p1');
    const next = patchPlayerReady(match, 'p1', true, deck());
    expect(next.players.find((p) => p.position === 1)!.playerId).toBe('n1');
    expect(next.players.find((p) => p.position === 3)!.playerId).toBe('bot-2');
    expect(next.claims).toEqual([]);
    expect(next.currentGame.hands.find((h) => h.playerId === 'n1')!.dominoes).toHaveLength(7);
  });

  it('opens with the seat after the last opener even when that seat changed hands', () => {
    let match = withBots();
    match = { ...match, currentGame: { ...match.currentGame, firstActionBy: 'bot-1' } };
    const next = patchPlayerReady(atBreak(claimSeat(match, 'n1'), 'p1'), 'p1', true, deck());
    expect(next.currentGame.firstActionBy).toBe('p3');
  });

  it('replaces a player away for the whole hand with a bot', () => {
    let match = setAutopilot(dealt(), ['p2'], true);
    match = { ...match, awaySince: { p2: match.currentGame.dealtOn! } };
    const next = patchPlayerReady(atBreak(match, 'p1'), 'p1', true, deck());
    expect(next.replaced).toEqual(['p2']);
    expect(next.players.find((p) => p.position === 1)!.playerId).toBe('bot-1');
    expect(next.autopilot).toEqual([]);
  });

  it('lets a claim take the seat of a player replaced at the same break, lowest position first', () => {
    // Bots at 1 and 3; p3 at 2 has been away all hand. Two claims: they take seats 1 and 2.
    let match = setAutopilot(withBots(), ['p3'], true);
    match = { ...match, awaySince: { p3: match.currentGame.dealtOn! } };
    match = claimSeat(claimSeat(match, 'n1'), 'n2');
    const next = patchPlayerReady(atBreak(match, 'p1'), 'p1', true, deck());
    expect(next.players.find((p) => p.position === 1)!.playerId).toBe('n1');
    expect(next.players.find((p) => p.position === 2)!.playerId).toBe('n2');
    expect(next.players.find((p) => p.position === 3)!.playerId).toBe('bot-2');
    expect(next.replaced).toEqual(['p3']);
  });

  it('keeps a player who went away partway through the hand', () => {
    let match = setAutopilot(dealt(), ['p2'], true);
    match = { ...match, awaySince: { p2: new Date(Date.parse(match.currentGame.dealtOn!) + 1000).toISOString() } };
    const next = patchPlayerReady(atBreak(match, 'p1'), 'p1', true, deck());
    expect(next.players.find((p) => p.position === 1)!.playerId).toBe('p2');
  });

  it('replaces nobody in a match stored before deal times were kept', () => {
    let match = setAutopilot(dealt(), ['p2'], true);
    const { dealtOn: _d, ...oldGame } = match.currentGame;
    match = { ...match, currentGame: oldGame };
    const next = patchPlayerReady(atBreak(match, 'p1'), 'p1', true, deck());
    expect(next.players.find((p) => p.position === 1)!.playerId).toBe('p2');
  });

  it('does none of this outside Over the table', () => {
    const daily = setAutopilot({ ...dealt(), mode: 'daily' as const }, ['p2'], true);
    const next = patchPlayerReady(atBreak(daily, 'p1'), 'p1', true, deck());
    expect(next.replaced).toBeUndefined();
  });
});
```

Add `claimSeat`, `releaseClaim`, `replaceWithBot`, `TAKEOVER_MAX_MARKS` to the `./live` import.

- [ ] **Step 2: Run to see it fail**

Run: `cd cloudflare && npm test -w @fortytwo/rules -- live`
Expected: FAIL (`claimSeat` not exported).

- [ ] **Step 3: Implement `claimSeat`, `releaseClaim`, `isAwayAllHand`, `seatChangesAtBreak` in `live.ts`**

`live.ts` imports `matchScores` from `./matchEngine` (already imports `hasBeenDealt` from there).

```ts
// Asks for the next bot seat that comes up at a hand break. Only in an Over the table game under
// way that isn't nearly over, and never more claims than bot seats, so every claim is seated at
// the next break.
export function claimSeat(match: MatchState, playerId: string): MatchState {
  if (matchMode(match) !== 'live') throw new ValidationError('Only Over the table games take newcomers');
  if (!hasBeenDealt(match) || match.winningTeam !== null) throw new ValidationError('This game has no seat to take');
  if (Object.values(matchScores(match)).some((marks) => (marks ?? 0) >= TAKEOVER_MAX_MARKS)) {
    throw new ValidationError('This game is nearly over');
  }
  const claims = match.claims ?? [];
  if (match.players.some((p) => p.playerId === playerId) || claims.includes(playerId)) {
    throw new ValidationError("You're already at this table");
  }
  if (claims.length >= match.players.filter((p) => isBot(p.playerId)).length) {
    throw new ValidationError('No seat free at this table');
  }
  return { ...match, claims: [...claims, playerId] };
}

export function releaseClaim(match: MatchState, playerId: string): MatchState {
  if (!(match.claims ?? []).includes(playerId)) return match;
  return { ...match, claims: match.claims!.filter((id) => id !== playerId) };
}

// On autopilot since before this hand was dealt. A hand with no deal time (stored before it was
// kept) never counts, so nobody is replaced on the strength of a guess.
export function isAwayAllHand(match: MatchState, playerId: string): boolean {
  const since = match.awaySince?.[playerId];
  const dealtOn = match.currentGame.dealtOn;
  return isOnAutopilot(match, playerId) && since !== undefined && dealtOn !== undefined && since <= dealtOn;
}

// Who sits where for the next hand of an Over the table game: players away for the whole hand
// give their seats to bots, then claims take bot seats, lowest position first. Run as the hand
// break deals (patchPlayerReady). Anything else passes through untouched.
export function seatChangesAtBreak(match: MatchState): MatchState {
  if (matchMode(match) !== 'live') return match;
  let next = match;
  for (const p of match.players) {
    if (isAwayAllHand(next, p.playerId)) next = replaceWithBot(next, p.playerId);
  }
  const claims = [...(next.claims ?? [])];
  // Bot seats in position order, each handed the next claim in the order they were made.
  const taker = new Map<number, string>();
  for (const seat of next.players.filter((p) => isBot(p.playerId)).sort((a, b) => a.position - b.position)) {
    const claimant = claims.shift();
    if (claimant === undefined) break;
    taker.set(seat.position, claimant);
  }
  const players = next.players.map((p) => (taker.has(p.position) ? { ...p, playerId: taker.get(p.position)! } : p));
  return { ...next, players, claims };
}

// The match ended with claims still waiting: those players are let go, and their app searches again.
export function letClaimsGo(match: MatchState): MatchState {
  if ((match.claims ?? []).length === 0) return match;
  return { ...match, claims: [], bumped: [...(match.bumped ?? []), ...match.claims!] };
}
```

- [ ] **Step 4: Wire it into `patchPlayerReady` and `playDomino` (`matchEngine.ts`)**

`matchEngine.ts` imports `seatChangesAtBreak` from `./live` (it already imports the `MatchMode` type from there; `live.ts` imports from `matchEngine.ts` - this cycle is type-plus-function both ways, which ES modules resolve because neither file calls the other at load time).

In `patchPlayerReady`, replace the dealing block's start:

```ts
  if (gameWinningTeam(match.currentGame) !== null && players.every((p) => p.ready)) {
    const lastGame = match.currentGame;
    const totalGamesPlayed = Object.values(match.games).reduce((sum, games) => sum + (games?.length ?? 0), 0);

    // The opener is found by seat, before any seat changes hands below: the last opener may be
    // a player whose seat a bot or a newcomer is about to take.
    const lastOpenerPosition = match.players.find((p) => p.playerId === lastGame.firstActionBy)!.position;
    const seated = seatChangesAtBreak({ ...match, players });
    players = seated.players;
    const firstActionBy = players.find((p) => p.position === nextPosition(lastOpenerPosition))!.playerId;
    match = seated;
```

(`match` is a parameter; reassigning it is fine - or rename to a local `table` if lint complains.) Keep the rest of the block as it is, building `hands` from the new `players`, and add `dealtOn: now()` (Task 2). The final `return { ...match, players, currentGame, updatedOn: now() };` now carries `claims`, `replaced`, `autopilot` and `awaySince` from `seated`.

In `playDomino`, where the match result is returned:

```ts
  const result = { ...match, currentGame, games, winningTeam: matchWinningTeam, updatedOn: now() };
  return matchWinningTeam !== null ? letClaimsGo(result) : result;
```
(import `letClaimsGo` from `./live` alongside `seatChangesAtBreak`).

Add a test for `letClaimsGo` to the `the hand break` describe:

```ts
  it('lets claimants go when the match ends before a seat comes up', () => {
    const next = letClaimsGo(claimSeat(withBots(), 'n1'));
    expect(next.claims).toEqual([]);
    expect(next.bumped).toEqual(['n1']);
    const quiet = withBots();
    expect(letClaimsGo(quiet)).toBe(quiet);
  });
```

Export `claimSeat`, `releaseClaim`, `isAwayAllHand`, `seatChangesAtBreak`, `letClaimsGo` from `index.ts`, and add `letClaimsGo` and `markHand`'s `Game` type import (`import type { Game } from './game';`) to the test file.

- [ ] **Step 5: Run the package**

Run: `cd cloudflare && npm test -w @fortytwo/rules && npm run typecheck -w @fortytwo/rules`
Expected: PASS, including the existing `patchPlayerReady` tests in `matchEngine.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add cloudflare/packages/rules
git commit -m "feat(rules): claims take bot seats at the hand break; away players give theirs to bots"
```

---

### Task 5: Rules - pause and drop, `autoBid`, stats

**Files:**
- Modify: `cloudflare/packages/rules/src/live.ts` (`liveDeadline`, `markAutoBid`)
- Modify: `cloudflare/packages/rules/src/stats.ts`
- Modify: `cloudflare/packages/rules/src/index.ts`
- Test: `cloudflare/packages/rules/src/live.test.ts`, `cloudflare/packages/rules/src/stats.test.ts`

**Interfaces:**
- Produces:
  - `LiveDeadline.kind: 'fill' | 'turn' | 'drop'`. `drop` comes when every present human is among those waited on; `at = updatedOn + LIVE_TURN_MS + LIVE_ABANDON_MS`.
  - `markAutoBid(match, playerId): MatchState` - sets `autoBid: true` on that player's current hand.
  - `PlayerMatchStats.handsPlayed: number`; `withBots` reads `hadBots`.
  - `MIN_HANDS_FOR_RESULT = 3` exported from `stats.ts`.

- [ ] **Step 1: Write the failing tests**

`live.test.ts`:
```ts
describe('pause and drop', () => {
  it('drops instead of autopiloting the last present player', () => {
    let match = createMatch('p1', 'live');
    match = takeSeat(match, 'bot-1', 1);
    match = takeSeat(match, 'bot-2', 2);
    match = takeSeat(match, 'bot-3', 3, deck());
    expect(liveDeadline(match)).toEqual({ kind: 'drop', at: Date.parse(match.updatedOn) + LIVE_TURN_MS + LIVE_ABANDON_MS, playerIds: ['p1'] });
  });

  it('still times a player out while someone else is present', () => {
    expect(liveDeadline(dealt())!.kind).toBe('turn');
  });

  it('drops when the only other human is already away', () => {
    const match = setAutopilot(dealt(), ['p2', 'p3', 'p4'], true);
    expect(liveDeadline(match)!.kind).toBe('drop');
  });
});

describe('markAutoBid', () => {
  it('marks the hand the bot bid for', () => {
    const next = markAutoBid(dealt(), 'p1');
    expect(next.currentGame.hands.find((h) => h.playerId === 'p1')!.autoBid).toBe(true);
    expect(next.currentGame.hands.find((h) => h.playerId === 'p2')!.autoBid).toBeUndefined();
  });
});
```

`stats.test.ts` (reuse the file's existing finished-match fixture; it's the one `matchStatsFor` tests already build - call it `finished` below):
```ts
it('counts a match bots ever sat in as a bots game', () => {
  const rows = matchStatsFor({ ...finished, hadBots: true });
  expect(rows.every((r) => r.withBots)).toBe(true);
});

it('counts the hands a player played, leaving out the ones a bot bid for them', () => {
  const hands = (g: Game) => g.hands.map((h) => (h.playerId === finished.players[0].playerId ? { ...h, autoBid: true as const } : h));
  const firstTeam = Object.keys(finished.games)[0] as unknown as Teams;
  const games = { ...finished.games, [firstTeam]: finished.games[firstTeam]!.map((g, i) => (i === 0 ? { ...g, hands: hands(g) } : g)) };
  const filed = Object.values(finished.games).reduce((n, gs) => n + (gs?.length ?? 0), 0);
  const row = matchStatsFor({ ...finished, games }).find((r) => r.playerId === finished.players[0].playerId)!;
  expect(row.handsPlayed).toBe(filed - 1);
});

it("leaves a hand the bot bid for out of the player's bids", () => {
  // Pick a filed game the first player bid and won; mark it autoBid; bidsWon drops by one.
  const id = finished.players[0].playerId;
  const before = matchStatsFor(finished).find((r) => r.playerId === id)!;
  const games = Object.fromEntries(Object.entries(finished.games).map(([team, gs]) => [team, gs!.map((g) =>
    g.biddingPlayerId === id ? { ...g, hands: g.hands.map((h) => (h.playerId === id ? { ...h, autoBid: true as const } : h)) } : g)]));
  const after = matchStatsFor({ ...finished, games }).find((r) => r.playerId === id)!;
  expect(after.bidsWon).toBe(0);
  expect(before.bidsWon).toBeGreaterThan(0);
});
```
If the fixture's first player never wins a bid, pick the player who does (`finished.currentGame.biddingPlayerId` of a filed game).

- [ ] **Step 2: Run to see them fail**

Run: `cd cloudflare && npm test -w @fortytwo/rules -- live stats`
Expected: FAIL.

- [ ] **Step 3: Implement**

`live.ts`:
```ts
export interface LiveDeadline {
  kind: 'fill' | 'turn' | 'drop';
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
  const turnEnds = Date.parse(match.updatedOn) + LIVE_TURN_MS;
  // Nobody else is here to play with: rather than let bots play the table on its own, it waits,
  // and is dropped if they don't come back.
  const present = match.players.filter((p) => isPresent(match, p.playerId)).map((p) => p.playerId);
  if (present.every((id) => humans.includes(id))) return { kind: 'drop', at: turnEnds + LIVE_ABANDON_MS, playerIds: humans };
  return { kind: 'turn', at: turnEnds, playerIds: humans };
}

// The bot made this player's bid or trump call while they were on autopilot (bots.ts), so the
// hand doesn't count as theirs in stats.
export function markAutoBid(match: MatchState, playerId: string): MatchState {
  const hands = match.currentGame.hands.map((h) => (h.playerId === playerId ? { ...h, autoBid: true as const } : h));
  return { ...match, currentGame: { ...match.currentGame, hands } };
}
```

`stats.ts`: add to `PlayerMatchStats`:
```ts
  // Filed hands they played themselves: holding the seat, and making their own bid. A match's
  // result counts for them only from MIN_HANDS_FOR_RESULT up (the Worker's stats queries).
  handsPlayed: number;
```
Above `matchStatsFor`:
```ts
// A player who took over a seat late must have played this many hands for the win or loss to count.
export const MIN_HANDS_FOR_RESULT = 3;
```
In `matchStatsFor`: `const withBots = match.hadBots ?? match.players.some((p) => isBot(p.playerId));`, initialise `handsPlayed: 0`, and in the loop over `filed`:
```ts
      for (const { game, wonBy } of filed) {
        if (wonBy === team) stats.marksWon += gameValue(game) ?? 0;
        const own = game.hands.find((h) => h.playerId === player.playerId);
        if (own === undefined || own.autoBid) continue;
        stats.handsPlayed++;
        if (game.biddingPlayerId !== player.playerId) continue;
        const bid = own.bid;
        if (bid === null || bid === Bid.Pass) continue;
        // ...the existing bidsWon / bidsMade / points / marks / trumps lines, unchanged...
```
Note: `marksWon` stays the team's whole-match tally, as the spec says.

Export `markAutoBid`, `MIN_HANDS_FOR_RESULT` from `index.ts`.

- [ ] **Step 4: Run the package**

Run: `cd cloudflare && npm test -w @fortytwo/rules && npm run typecheck -w @fortytwo/rules`
Expected: PASS. Existing `stats.test.ts` row expectations gain `handsPlayed` - update them to the count of filed hands each player holds.

- [ ] **Step 5: Commit**

```bash
git add cloudflare/packages/rules
git commit -m "feat(rules): pause the last player's turn instead of autopiloting, and count hands played"
```

---

### Task 6: Worker - bots mark `autoBid`; stats migration and queries

**Files:**
- Modify: `cloudflare/apps/worker/src/bots.ts` (`applyBotAction`)
- Create: `cloudflare/apps/worker/migrations/0011_player_match_stats_hands_played.sql`
- Modify: `cloudflare/apps/worker/src/stats.ts` (`recordMatchStats`, `readPlayerStats`)
- Test: `cloudflare/apps/worker/test/stats.test.ts`, a new case in `cloudflare/apps/worker/test/matchDOBots.test.ts`

**Interfaces:**
- Consumes: `markAutoBid`, `isOnAutopilot`, `MIN_HANDS_FOR_RESULT`, `PlayerMatchStats.handsPlayed`.
- Produces: `player_match_stats.hands_played INTEGER` (nullable).

- [ ] **Step 1: Write the failing tests**

`stats.test.ts` - follow the file's existing pattern of inserting rows then calling `readPlayerStats` (look at how it seeds rows; reuse that helper). Add:
```ts
it('counts the bids of a short match but not its result', async () => {
  // Two rows for p: a full match won, and a 2-hand cameo won with one bid.
  await seed({ matchId: 'm-full', playerId: 'p', won: 1, bidsWon: 1, handsPlayed: 8 });
  await seed({ matchId: 'm-short', playerId: 'p', won: 1, bidsWon: 1, handsPlayed: 2 });
  const stats = await readPlayerStats(testEnv, 'p');
  expect(stats.all.played).toBe(1);
  expect(stats.all.won).toBe(1);
  expect(stats.all.bidsWon).toBe(2);
});

it('counts rows from before hands were recorded', async () => {
  await seed({ matchId: 'm-old', playerId: 'q', won: 1, bidsWon: 0, handsPlayed: null });
  expect((await readPlayerStats(testEnv, 'q')).all.played).toBe(1);
});
```
If the file has no `seed` helper, add one that runs the `INSERT` from `recordMatchStats` with zeros for the columns not given and `hands_played` bound to the value.

`matchDOBots.test.ts`:
```ts
it("marks a hand the bot bid for a player on autopilot", async () => {
  // Set up a dealt live match where p1 is on autopilot and it's p1's bid (copy the setup the file
  // uses for autopilot play), fire the alarm once, then:
  const match = await stored(stub);
  expect(match.currentGame.hands.find((h) => h.playerId === 'p1')!.autoBid).toBe(true);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd cloudflare && npm test -w apps/worker -- stats matchDOBots`
Expected: FAIL (`hands_played` column missing; `autoBid` undefined).

- [ ] **Step 3: Implement**

Migration `0011_player_match_stats_hands_played.sql`:
```sql
-- How many hands the player played themselves in the match (stats.ts). A player who took over a
-- seat late may have played only a few; their result counts from MIN_HANDS_FOR_RESULT up, their
-- bids always. Null on rows from before it was kept, which count as before.
ALTER TABLE player_match_stats ADD COLUMN hands_played INTEGER;
```

`bots.ts` - import `isOnAutopilot`, `markAutoBid`; rename the current `applyBotAction` to `decideAndApply` (unexported) and add:
```ts
// Performs exactly one bot action. A bid or trump call made for a player on autopilot is marked
// on their hand, so it isn't counted as theirs (stats.ts).
export function applyBotAction(match: MatchState, action: BotAction, bot: Bot | null): MatchState {
  const next = decideAndApply(match, action, bot);
  const forAway = (action.kind === 'bid' || action.kind === 'setTrump') && isOnAutopilot(match, action.playerId);
  return forAway ? markAutoBid(next, action.playerId) : next;
}
```
Keep the existing comment on `decideAndApply`.

`stats.ts` (Worker):
- Insert: add `hands_played` after `completed_on` in the column list, bump the placeholder count to `13 + TRUMP_KEYS.length`, bind `r.handsPlayed` after `match.updatedOn`.
- Read: import `MIN_HANDS_FOR_RESULT`; define once near the top:
  ```ts
  // A match's result counts unless the player joined too late to play MIN_HANDS_FOR_RESULT hands.
  const COUNTS = '(hands_played IS NULL OR hands_played >= ?)';
  ```
  Totals query:
  ```sql
  SELECT with_bots AS withBots, SUM(CASE WHEN ${COUNTS} THEN 1 ELSE 0 END) AS played,
    SUM(CASE WHEN ${COUNTS} THEN won ELSE 0 END) AS won,
    SUM(CASE WHEN ${COUNTS} THEN marks_won ELSE 0 END) AS marksWon,
    SUM(bids_won) AS bidsWon, ...unchanged...
  FROM player_match_stats WHERE player_id = ? GROUP BY with_bots
  ```
  `.bind(MIN_HANDS_FOR_RESULT, MIN_HANDS_FOR_RESULT, MIN_HANDS_FOR_RESULT, playerId)`.
  Partner query: `... COUNT(*) AS played, SUM(won) AS won FROM player_match_stats WHERE player_id = ? AND ${COUNTS} GROUP BY partner_id, with_bots`, `.bind(playerId, MIN_HANDS_FOR_RESULT)`.

- [ ] **Step 4: Run the Worker suite**

Run: `cd cloudflare && npm test -w apps/worker && npm run typecheck -w apps/worker`
Expected: PASS. (Test setup applies migrations from the folder - `test/applyMigrations.ts` - so 0011 is picked up.)

- [ ] **Step 5: Commit**

```bash
git add cloudflare/apps/worker
git commit -m "feat(worker): count a late joiner's bids but only a full-enough match's result"
```

---

### Task 7: MatchDO - claims, Leave game, drop, offers, seat sync

**Files:**
- Modify: `cloudflare/apps/worker/src/matchDO.ts`
- Modify: `cloudflare/apps/worker/src/routes/matches.ts` (DELETE comment only; behaviour comes from `leave`)
- Create: `cloudflare/apps/worker/test/matchDOTakeover.test.ts`

**Interfaces:**
- Consumes: `claimSeat`, `releaseClaim`, `replaceWithBot`, `isPresent`, `liveDeadline` with `drop` (Tasks 2-5); `Matchmaker.offer` (Task 9 - call it through the stub; until Task 9 lands, the call fails inside `waitUntil` and is swallowed by `.catch`).
- Produces:
  - `MatchDO.claimSeat(playerId): Promise<MatchResult<MatchState>>`
  - `MatchDO.leave(playerId)` now also: releases a claim; in a dealt `live` match, hands the seat to a bot (or drops the match when the leaver was the last present human).
  - Alarm `drop`: final broadcast with `bumped = claims`, then `destroy()` and the lobby row removed.
  - Every change that seats a new bot in a `live` match calls `Matchmaker.offer(id)`.
  - Every change that changes who's seated runs `syncLobbyIndex`.

- [ ] **Step 1: Write the failing tests** (`matchDOTakeover.test.ts`, helpers copied from `matchDOLive.test.ts`: `stubFor`, `stored`, `windBack`, `ago`)

```ts
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { LIVE_ABANDON_MS, LIVE_TURN_MS, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';

// ...stubFor / stored / windBack / ago as in matchDOLive.test.ts...

// p1 alone with three bots in a dealt Over the table game.
async function soloWithBots(name: string) {
  const stub = stubFor(name);
  await stub.create('p1', name, 'live');
  await stub.addBots('p1');
  return stub;
}

describe('seat takeover', () => {
  it('takes a claim and refuses one too many', async () => {
    const stub = await soloWithBots('to-claim');
    for (const id of ['n1', 'n2', 'n3']) expect((await stub.claimSeat(id)).ok).toBe(true);
    const fourth = await stub.claimSeat('n4');
    expect(fourth.ok).toBe(false);
  });

  it('lets a claimant cancel', async () => {
    const stub = await soloWithBots('to-cancel');
    await stub.claimSeat('n1');
    const left = await stub.leave('n1');
    expect(left.ok && !left.value.deleted && left.value.match.claims).toEqual([]);
  });

  it('gives a leaver\'s seat to a bot straight away, mid-hand', async () => {
    const stub = stubFor('to-leave');
    await stub.create('p1', 'to-leave', 'live');
    await stub.takeSeat('p2', 1);
    await stub.addBots('p1');
    const left = await stub.leave('p2');
    expect(left.ok && !left.value.deleted).toBe(true);
    const match = await stored(stub);
    expect(match.players.find((p) => p.position === 1)!.playerId).toMatch(/^bot-/);
    expect(match.replaced).toEqual(['p2']);
  });

  it('drops the match when the last present player leaves', async () => {
    const stub = await soloWithBots('to-last-leave');
    const left = await stub.leave('p1');
    expect(left.ok && left.value.deleted).toBe(true);
    expect((await stub.getMatch()).ok).toBe(false);
  });

  it('waits on the last present player instead of autopiloting them, then drops the match', async () => {
    const stub = await soloWithBots('to-drop');
    // Make it p1's turn: let the bots act until the table waits on p1.
    for (let i = 0; i < 10 && (await stored(stub)).currentGame.currentPlayerId !== 'p1'; i++) await runDurableObjectAlarm(stub);
    await windBack(stub, () => ({ updatedOn: ago(LIVE_TURN_MS + 1000) }));
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).autopilot ?? []).toEqual([]);

    await windBack(stub, () => ({ updatedOn: ago(LIVE_TURN_MS + LIVE_ABANDON_MS + 1000) }));
    await runDurableObjectAlarm(stub);
    expect((await stub.getMatch()).ok).toBe(false);
    const row = await testEnv.DB.prepare('SELECT id FROM matches WHERE id = ?').bind('to-drop').first();
    expect(row).toBeNull();
  });

  it('tells claimants they were let go before a dropped match closes', async () => {
    const stub = await soloWithBots('to-bump');
    await stub.claimSeat('n1');
    const broadcasts = await runInDurableObject(stub, async (instance) => {
      const sent: MatchState[] = [];
      // Capture what the DO broadcasts by spying on its private broadcast.
      const original = (instance as unknown as { broadcast(m: MatchState): void }).broadcast.bind(instance);
      (instance as unknown as { broadcast(m: MatchState): void }).broadcast = (m) => { sent.push(m); original(m); };
      await instance.leave('p1');
      return sent;
    });
    expect(broadcasts.at(-1)!.bumped).toEqual(['n1']);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd cloudflare && npm test -w apps/worker -- matchDOTakeover`
Expected: FAIL (`claimSeat` is not a method; leave refuses after the deal).

- [ ] **Step 3: Implement in `matchDO.ts`**

Imports: add `claimSeat`, `releaseClaim`, `replaceWithBot`, `isPresent`, `isBot` from `@fortytwo/rules`; `deleteFromLobbyIndex` from `./lobby`.

New RPC:
```ts
  // A newcomer asks for the next bot seat at this Over the table game (the Matchmaker calls this).
  // They're seated at the next hand break; until then they watch.
  claimSeat(playerId: string): Promise<MatchResult<MatchState>> {
    return this.update(playerId, (match) => claimSeat(match, playerId));
  }
```

Replace `leave`:
```ts
  // Leaving: before the deal, takes the player back out (the last human out deletes the match -
  // how a creator cancels a match nobody joined). A claimant gives up their claim. In an Over the
  // table game under way a bot takes the seat, unless nobody else is present, which drops the
  // match. The caller drops the lobby rows when it's deleted (routes/matches.ts).
  leave(playerId: string): Promise<MatchResult<LeaveResult>> {
    return this.read(async (match): Promise<LeaveResult> => {
      if ((match.claims ?? []).includes(playerId)) {
        const next = releaseClaim(match, playerId);
        await this.save(next);
        this.broadcast(next);
        return { deleted: false, match: next };
      }
      if (matchMode(match) === 'live' && hasBeenDealt(match) && match.winningTeam === null) {
        assertIsMatchPlayer(match, playerId);
        const othersPresent = match.players.some((p) => p.playerId !== playerId && isPresent(match, p.playerId));
        if (!othersPresent) {
          await this.drop(match);
          return { deleted: true };
        }
        const next = replaceWithBot(match, playerId);
        await this.save(next);
        this.publish(match, next);
        await this.schedule(next);
        this.offerIfBotSeated(match, next);
        return { deleted: false, match: next };
      }
      const next = removePlayer(match, playerId);
      if (!hasHumanPlayers(next)) {
        await this.destroy();
        return { deleted: true };
      }
      await this.save(next);
      this.broadcast(next);
      await this.schedule(next);
      return { deleted: false, match: next };
    });
  }
```
(`hasBeenDealt` is already exported from rules; add it to the import.)

Drop and offer helpers:
```ts
  // Drops a game with nobody left to play it: claimants hear they were let go (their app searches
  // again), then it's deleted like a match whose last player left. No stats are written.
  private async drop(match: MatchState): Promise<void> {
    const claims = match.claims ?? [];
    if (claims.length > 0) this.broadcast({ ...match, claims: [], bumped: [...(match.bumped ?? []), ...claims] });
    await this.destroy();
    await bestEffort(match.id, () => deleteFromLobbyIndex(this.env.DB, match.id));
  }

  // A bot just took a seat at an Over the table game: it has a seat for a newcomer, so the
  // Matchmaker hears about it (it may have dropped the table from its list). Fire and forget - a
  // lost offer only means the seat isn't found.
  private offerIfBotSeated(previous: MatchState | null, next: MatchState): void {
    if (matchMode(next) !== 'live' || next.winningTeam !== null || !hasBeenDealt(next)) return;
    const bots = (m: MatchState | null) => m?.players.filter((p) => isBot(p.playerId)).map((p) => p.playerId) ?? [];
    const before = new Set(bots(previous));
    if (!bots(next).some((id) => !before.has(id))) return;
    const matchmaker = this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName('global'));
    this.ctx.waitUntil(matchmaker.offer(next.id).catch((error: unknown) => console.error(`OFFER FAILED for ${next.id}`, error)));
  }

  // Who's seated changed (a claim seated, a bot took over): the lobby lists it.
  private async syncIfSeatsChanged(previous: MatchState, next: MatchState): Promise<void> {
    const ids = (m: MatchState) => m.players.map((p) => `${p.position}:${p.playerId}`).sort().join();
    if (ids(previous) !== ids(next)) await bestEffort(next.id, () => syncLobbyIndex(this.env.DB, next));
  }
```

Call sites:
- `update()`: after `await this.schedule(next);` add `this.offerIfBotSeated(match, next); await this.syncIfSeatsChanged(match, next);`
- `alarm()` bot-action branch: after `this.publish(match, next);` add `this.offerIfBotSeated(match, next); await this.syncIfSeatsChanged(match, next);` (bot fill via `addBots` goes through `update`, seats changes at the break through either).
- `alarm()` deadline branch, replace the `next` line and what follows:
  ```ts
    if (deadline.kind === 'drop') {
      await this.drop(match);
      return;
    }
    const next = deadline.kind === 'fill' ? seatBots(match) : setAutopilot(match, deadline.playerIds, true);
    await this.save(next);
    await this.schedule(next);
    this.publish(match, next);
    this.offerIfBotSeated(match, next);
    if (deadline.kind === 'fill') await bestEffort(next.id, () => syncLobbyIndex(this.env.DB, next));
  ```
- `createRematch`: after `await this.schedule(match);` add `this.offerIfBotSeated(null, match);`.
- In `update()`, the autopilot-off line: also clear when the actor took an action - unchanged (`setAutopilot(..., false)` now clears `awaySince` too).

Also in `routes/matches.ts`, update the DELETE route's comment to describe the three cases (before the deal, a claim, a game under way). Its code already handles `deleted` and `match`.

- [ ] **Step 4: Run the Worker suite**

Run: `cd cloudflare && npm test -w apps/worker && npm run typecheck -w apps/worker`
Expected: PASS. `matchDOLeave.test.ts` may have a test that leaving a dealt match is refused - keep it for `custom`/`daily` (it should still pass); if it uses a `live` match, change that test to `custom`.

- [ ] **Step 5: Commit**

```bash
git add cloudflare/apps/worker
git commit -m "feat(worker): claims, Leave game and dropping empty tables in MatchDO"
```

---

### Task 8: Worker - push the joiner when they're seated

**Files:**
- Modify: `cloudflare/apps/worker/src/push/notices.ts`
- Test: `cloudflare/apps/worker/test/push.notices.test.ts`

**Interfaces:**
- Produces: `pushNotices(previous, next)` adds a `started` notice for every human in `next.players` who wasn't in `previous.players`, in a match `previous` had already dealt.

- [ ] **Step 1: Write the failing test**

```ts
it('tells a newcomer when they take a seat in a game under way', () => {
  const previous = dealtLiveWithBot(); // a dealt live match with bot-1 at position 1 (build with createMatch/takeSeat as the file's other fixtures do)
  const next = { ...previous, players: previous.players.map((p) => (p.playerId === 'bot-1' ? { ...p, playerId: 'n1' } : p)) };
  const notices = pushNotices(previous, next);
  expect(notices.find((n) => n.playerId === 'n1')?.kind).toBe('started');
  expect(notices.some((n) => n.playerId !== 'n1' && n.kind === 'started')).toBe(false);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd cloudflare && npm test -w apps/worker -- push.notices`
Expected: FAIL.

- [ ] **Step 3: Implement** - after the existing `justDealt` block in `pushNotices`:

```ts
  // A newcomer took over a seat in a game under way (Over the table's hand break).
  if (previous !== null && hasBeenDealt(previous)) {
    const before = new Set(previous.players.map((p) => p.playerId));
    for (const id of humans) {
      if (!before.has(id)) add(id, 'started', "You're in", 'You took a seat - your first hand is dealt.');
    }
  }
```
(Import `hasBeenDealt` if the file doesn't yet.)

- [ ] **Step 4: Run to see it pass**

Run: `cd cloudflare && npm test -w apps/worker -- push.notices`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare/apps/worker
git commit -m "feat(worker): push a newcomer when they're seated at a game under way"
```

---

### Task 9: Matchmaker - games under way, claims and offers

**Files:**
- Modify: `cloudflare/apps/worker/src/matchmaker.ts`
- Test: `cloudflare/apps/worker/test/matchmaker.test.ts`

**Interfaces:**
- Consumes: `MatchDO.claimSeat` (Task 7).
- Produces:
  - `Matchmaker.offer(matchId: string): Promise<void>` - adds to `open:live` once, through the `play` queue.
  - `play('live')` order: an existing seat or claim -> tables still filling -> games under way (claim) -> new table.
  - Storage key `claim:<playerId>` = match id of their claim.

- [ ] **Step 1: Write the failing tests**

```ts
// A dealt live table with p1 and three bots, in mm's list (p1 started it, then filled with bots).
async function underWay(mm: ReturnType<typeof matchmaker>) {
  const started = await mm.play('p1', 'live');
  await matchStub(started.id).addBots('p1');
  return started.id;
}

describe('Matchmaker and games under way', () => {
  it('prefers a table still filling over a game under way, even an older one', async () => {
    const mm = matchmaker('mm-prefer-filling');
    // A game under way first in the list, then a table still filling - both made directly and
    // offered, since playing would claim at the first before the second existed.
    await matchStub('g-busy').create('p1', 'g-busy', 'live');
    await matchStub('g-busy').addBots('p1');
    await matchStub('g-filling').create('a', 'g-filling', 'live');
    await mm.offer('g-busy');
    await mm.offer('g-filling');

    const seated = await mm.play('b', 'live');
    expect(seated.id).toBe('g-filling');
    const busy = await matchStub('g-busy').getMatch();
    expect(busy.ok && (busy.value.claims ?? []).length).toBe(0);
  });

  it('claims a bot seat in a game under way when no table is filling', async () => {
    const mm = matchmaker('mm-claim');
    const id = await underWay(mm);
    const joined = await mm.play('n1', 'live');
    expect(joined.id).toBe(id);
    expect(joined.claims).toEqual(['n1']);
  });

  it('returns the game you claim in when you press play again', async () => {
    const mm = matchmaker('mm-claim-again');
    const id = await underWay(mm);
    await mm.play('n1', 'live');
    await mm.play('n2', 'live');
    await mm.play('n3', 'live'); // all three bot seats claimed: the table drops off the list
    const again = await mm.play('n1', 'live');
    expect(again.id).toBe(id);
  });

  it('starts a new table once every bot seat is claimed', async () => {
    const mm = matchmaker('mm-claims-full');
    const id = await underWay(mm);
    for (const n of ['n1', 'n2', 'n3']) await mm.play(n, 'live');
    const fresh = await mm.play('n4', 'live');
    expect(fresh.id).not.toBe(id);
    expect(fresh.players.map((p) => p.playerId)).toEqual(['n4']);
  });

  it('takes an offered table back onto the list, once', async () => {
    const mm = matchmaker('mm-offer');
    const id = await underWay(mm);
    await mm.offer(id);
    await mm.offer(id);
    const list = await runInDurableObject(mm, (_i, state) => state.storage.get<string[]>('open:live'));
    expect(list!.filter((x) => x === id)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd cloudflare && npm test -w apps/worker -- matchmaker`
Expected: FAIL (`offer` missing; dealt tables are dropped, so no claims).

- [ ] **Step 3: Implement**

```ts
  offer(matchId: string): Promise<void> {
    const turn = this.queue.then(async () => {
      const open = (await this.ctx.storage.get<string[]>('open:live')) ?? [];
      if (!open.includes(matchId)) await this.ctx.storage.put('open:live', [...open, matchId]);
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }
```

In `seat()`, for `live`, before the existing pre-scan:
```ts
    if (mode === 'live') {
      const claimed = await this.ctx.storage.get<string>(`claim:${playerId}`);
      if (claimed !== undefined) {
        const match = await this.matchStub(claimed).getMatch().catch(() => null);
        const holds = match?.ok && match.value.winningTeam === null &&
          ((match.value.claims ?? []).includes(playerId) || match.value.players.some((p) => p.playerId === playerId));
        if (holds) return match.value;
        await this.ctx.storage.delete(`claim:${playerId}`);
      }
    }
```

Change the main loop so a dealt `live` table is set aside for a second pass instead of dropped. Replace `trySeat`'s "gone, full or under way" return with a three-way answer:
```ts
  // Tries to seat the player at one table still filling: `seated` is where they ended up there
  // (null if nowhere), `keep` whether the table stays on the list, `underWay` whether it's a live
  // game already dealt, to try for a claim once no filling table took them.
  private async trySeat(id: string, playerId: string, mode: QueueMode): Promise<{ seated: MatchState | null; keep: boolean; underWay?: boolean }> {
    const table = this.matchStub(id);
    let found = await table.getMatch();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!found.ok) return { seated: null, keep: false };
      if (found.value.players.length >= 4 || hasBeenDealt(found.value)) {
        const underWay = mode === 'live' && found.value.winningTeam === null;
        return { seated: null, keep: underWay, underWay };
      }
      // ...the rest of the existing body unchanged...
```
In `seat()`'s loop, pass `mode`, and collect `underWay` ids in order. After the loop, if `seated === null` and `mode === 'live'`, try them oldest first:
```ts
    if (seated === null && mode === 'live') {
      for (const id of underWay) {
        const claimed = await this.matchStub(id).claimSeat(playerId).catch(() => null);
        if (claimed?.ok) {
          seated = claimed.value;
          await this.ctx.storage.put(`claim:${playerId}`, id);
          break;
        }
        // Finished, nearly over, every bot seat claimed, or gone: off the list. A bot taking a seat
        // there later offers it back.
        stillOpen.splice(stillOpen.indexOf(id), 1);
      }
    }
```
(`stillOpen` keeps under-way ids from the first pass, since `keep` is true for them.) Update the class comment at the top of the file: the Matchmaker now hears from matches through `offer`, and keeps live games under way on its list.

- [ ] **Step 4: Run the Worker suite**

Run: `cd cloudflare && npm test -w apps/worker && npm run typecheck -w apps/worker`
Expected: PASS, including the existing Matchmaker tests.

- [ ] **Step 5: Commit**

```bash
git add cloudflare/apps/worker
git commit -m "feat(worker): the Matchmaker seats newcomers in bot seats of games under way"
```

---

### Task 10: Shared client helpers

**Files:**
- Modify: `cloudflare/packages/client/src/live.ts`
- Modify: `cloudflare/packages/client/src/index.ts` (if it re-exports by name)
- Test: `cloudflare/packages/client/src/live.test.ts`

**Interfaces:**
- Produces:
  - `viewerRole(match, viewerId): 'seated' | 'claiming' | 'bumped' | 'replaced' | 'stranger'`
  - `watchAnchor(match): string | null` - the player at the lowest position, to view the table from when not seated.
  - `seatChanges(previous, next): { position: number; from: string; to: string }[]`
  - `turnClock` also covers a paused table: returns `{ playerIds, remainingMs: 0, paused: true }` for a `drop` deadline (and `paused: false` for `turn`).

- [ ] **Step 1: Write the failing tests**

```ts
describe('viewerRole', () => {
  it('tells a seated player, a claimant, a bumped claimant, a replaced player and a stranger apart', () => {
    const match = { ...dealtLive(), claims: ['c'], bumped: ['b'], replaced: ['r'] };
    expect(viewerRole(match, 'p1')).toBe('seated');
    expect(viewerRole(match, 'c')).toBe('claiming');
    expect(viewerRole(match, 'b')).toBe('bumped');
    expect(viewerRole(match, 'r')).toBe('replaced');
    expect(viewerRole(match, 'x')).toBe('stranger');
  });
});

describe('seatChanges', () => {
  it('lists seats that changed hands', () => {
    const previous = dealtLive();
    const next = { ...previous, players: previous.players.map((p) => (p.position === 1 ? { ...p, playerId: 'n1' } : p)) };
    expect(seatChanges(previous, next)).toEqual([{ position: 1, from: previous.players.find((p) => p.position === 1)!.playerId, to: 'n1' }]);
    expect(seatChanges(previous, previous)).toEqual([]);
  });
});

describe('turnClock on a paused table', () => {
  it('shows the last player overdue', () => {
    const solo = soloWithBots(); // p1 + bot-1..3, dealt, p1 to act
    const clock = turnClock(solo, Date.parse(solo.updatedOn) + LIVE_TURN_MS + 5000);
    expect(clock).toEqual({ playerIds: ['p1'], remainingMs: 0, paused: true });
  });
});
```
Build `dealtLive` and `soloWithBots` with `createMatch`/`takeSeat` and a 28-domino deck as `packages/rules/src/live.test.ts` does.

- [ ] **Step 2: Run to see them fail**

Run: `cd cloudflare && npm test -w @fortytwo/client -- live`
Expected: FAIL.

- [ ] **Step 3: Implement** (append to `live.ts`; widen `turnClock`)

```ts
// How the viewer stands at this table, which decides what the match page shows them.
export type ViewerRole = 'seated' | 'claiming' | 'bumped' | 'replaced' | 'stranger';

export function viewerRole(match: MatchState, viewerId: string): ViewerRole {
  if (match.players.some((p) => p.playerId === viewerId)) return 'seated';
  if (match.claims?.includes(viewerId)) return 'claiming';
  if (match.bumped?.includes(viewerId)) return 'bumped';
  if (match.replaced?.includes(viewerId)) return 'replaced';
  return 'stranger';
}

// Someone watching without a seat sees the table from the first seat's side.
export function watchAnchor(match: MatchState): string | null {
  return [...match.players].sort((a, b) => a.position - b.position)[0]?.playerId ?? null;
}

// Seats whose player changed between two versions of a match: for "Sam took Bot 2's seat".
export function seatChanges(previous: MatchState, next: MatchState): { position: number; from: string; to: string }[] {
  return next.players.flatMap((p) => {
    const before = previous.players.find((q) => q.position === p.position);
    return before && before.playerId !== p.playerId ? [{ position: p.position, from: before.playerId, to: p.playerId }] : [];
  });
}

// Time left on an Over the table turn before a bot plays it, and whose it is. A paused table -
// the last player there ran out their turn - shows them overdue until they act or it's dropped.
export function turnClock(match: MatchState, now: number): { playerIds: string[]; remainingMs: number; paused: boolean } | null {
  const deadline = liveDeadline(match);
  if (deadline === null || deadline.kind === 'fill') return null;
  if (deadline.kind === 'drop') {
    const turnEnds = deadline.at - LIVE_ABANDON_MS;
    return { playerIds: deadline.playerIds, remainingMs: Math.max(0, turnEnds - now), paused: now >= turnEnds };
  }
  return { playerIds: deadline.playerIds, remainingMs: Math.max(0, deadline.at - now), paused: false };
}
```
Import `LIVE_ABANDON_MS`. Note a `drop` deadline before the turn has run out still counts down normally (`paused: false`). Update the existing `turnClock` tests' expected objects with `paused: false`. Export the new names from `index.ts` if it lists them.

- [ ] **Step 4: Run to see them pass**

Run: `cd cloudflare && npm test -w @fortytwo/client && npm run typecheck -w @fortytwo/client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare/packages/client
git commit -m "feat(web): client helpers for claimants, seat changes and a paused table"
```

---

### Task 11: Web match page

**Files:**
- Modify: `cloudflare/apps/web/src/pages/Match.tsx`
- Modify: `cloudflare/apps/web/src/components/Seat.tsx` (a `paused` flag on the clock)
- Test: `cloudflare/apps/web/src/pages/Match.test.tsx`

**Interfaces:**
- Consumes: `viewerRole`, `watchAnchor`, `seatChanges`, `turnClock` (Task 10); `client.play('live')` (`packages/client/src/api.ts:89`), `client.leaveMatch`.

- [ ] **Step 1: Write the failing tests** (in `Match.test.tsx`, using the file's existing render-with-socket harness; each test pushes one match over the mocked socket)

```tsx
it('shows a claimant the table without a hand, with Cancel', async () => {
  renderMatch({ ...dealtLiveWithBots(), claims: [ME] });
  expect(await screen.findByText(/Joining a game in progress. You'll take a seat when this hand ends./)).toBeInTheDocument();
  expect(screen.queryByLabelText('Your hand')).toBeNull();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
});

it('searches again when a claim is let go', async () => {
  const play = vi.fn().mockResolvedValue({ ...dealtLiveWithBots(), id: 'other' });
  renderMatch({ ...dealtLiveWithBots(), bumped: [ME] }, { play });
  expect(await screen.findByText(/That game ended - finding you another table/)).toBeInTheDocument();
  await waitFor(() => expect(play).toHaveBeenCalledWith('live'));
});

it('tells a replaced player a bot took their seat', async () => {
  renderMatch({ ...dealtLiveWithBots(), replaced: [ME] });
  expect(await screen.findByText(/A bot took your seat after you were away for a hand/)).toBeInTheDocument();
});

it('offers Leave game in an Over the table game under way', async () => {
  renderMatch(dealtLiveSeated());
  expect(await screen.findByRole('button', { name: 'Leave game' })).toBeInTheDocument();
});

it('says who took a seat', async () => {
  const { push } = renderMatch(dealtLiveSeated());
  push(withSeatTaken(dealtLiveSeated(), 1, 'n1'));
  expect(await screen.findByText(/took Bot 1's seat|took .*'s seat/)).toBeInTheDocument();
});
```
`ME` is the harness's signed-in id; build fixtures with `@fortytwo/rules` as the file's existing fixtures do. If the harness doesn't take a `play` override, mock `client` the way the file already mocks `leaveMatch`.

- [ ] **Step 2: Run to see them fail**

Run: `cd cloudflare && npm test -w apps/web -- Match`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `Match.tsx`:

1. After `liveMatch`/`myPlayerId` are known, compute
   ```ts
   const role = liveMatch && myPlayerId ? viewerRole(liveMatch, myPlayerId) : null;
   // A claimant watches from the first seat's side; everything that acts is switched off for them.
   const viewerId = role === 'claiming' ? watchAnchor(liveMatch!) : myPlayerId;
   const watching = role === 'claiming';
   ```
2. **Bumped:** a `useEffect` on `role === 'bumped'` that calls `client.play('live')` once (guard with a ref), `navigate(`/match/${found.id}`, { replace: true })` on success, and on failure sets state to show a **Find another** button that retries. Render `<p role="status">That game ended - finding you another table…</p>` meanwhile. Make the existing `deleted` effect skip when `role === 'bumped'` (the drop's final broadcast arrives before the close), so it doesn't toast "This match was deleted".
3. **Replaced:** before the unseated branch, `if (role === 'replaced')` render a panel like `match-join` with "A bot took your seat after you were away for a hand." and `<Link to="/">Back to lobby</Link>`.
4. **Unseated branch:** only for `role === 'stranger'` (today's seat picker). For `watching`, fall through to the table with `viewerId` in place of `myPlayerId` for `describeMatch`, `seatFor`, `openSeats`, `myPosition`, `seatPropsFor` and the trick geometry. Gate on `!watching`: `TurnAlerts`, the autopilot bar, `Hand`, bidding and trump panels, readying up, the rematch button, Leave game. In place of the hand, render:
   ```tsx
   <div className="claim-bar" role="status">
     <span>Joining a game in progress. You'll take a seat when this hand ends.</span>
     <button type="button" className="btn btn-sm btn-outline-secondary" disabled={leaveMutation.isPending}
       onClick={() => { leavingRef.current = true; leaveMutation.mutate(); }}>Cancel</button>
   </div>
   ```
   Reuse `autopilot-bar`'s CSS for `claim-bar` (add `.claim-bar` next to `.autopilot-bar` in `apps/web/src/styles/match.css`).
5. **Leave game:** in the rail where the match's menu/actions live (next to Summary), for `mode === 'live' && hasBeenDealt(match) && !isMatchOver && !watching`:
   ```tsx
   <button type="button" className="btn btn-sm btn-outline-danger" disabled={leaveMutation.isPending}
     onClick={() => { if (window.confirm('Leave this game? A bot takes your seat.')) { leavingRef.current = true; leaveMutation.mutate(); } }}>
     Leave game
   </button>
   ```
6. **Seat-change toast:** keep the previous match in a ref; when a new `liveMatch` arrives, for each of `seatChanges(previous, liveMatch)` call `toastInfo(`${nameText(names.nameFor(c.to))} took ${nameText(names.nameFor(c.from))}'s seat`)`. Skip the change where `c.to === myPlayerId` (they're being seated) - instead `toastInfo("You're in", 'You took a seat - your first hand is dealt.')`.
7. **Paused clock:** in `seatPropsFor`, pass `clock: clock?.playerIds.includes(playerId) ? formatClock(clock.remainingMs) : null` as now, and `paused: clock?.paused && clock.playerIds.includes(playerId)`. In `Seat.tsx`, accept `paused?: boolean` and render `Waiting…` next to the clock when set, with a `seat-clock-paused` class (style like the clock, in the warning colour).

- [ ] **Step 4: Run the web suite**

Run: `cd cloudflare && npm test -w apps/web && npm run typecheck -w apps/web && npm run lint -w apps/web`
Expected: PASS.

- [ ] **Step 5: Look at it**

Use the `run` skill to start the web app against a local Worker (`wrangler dev`), start an Over the table game, press Start now with bots, and in a second browser profile press Over the table: the second player should watch with the claim bar, then be seated at the next hand break with a toast on both screens. Leave game in the first profile: a bot takes the seat.

- [ ] **Step 6: Commit**

```bash
git add cloudflare/apps/web
git commit -m "feat(web): watch a game while waiting for a seat, Leave game, and seat-change toasts"
```

---

### Task 12: Mobile match screen

**Files:**
- Modify: `cloudflare/apps/mobile/src/app/match/[id].tsx`
- Modify: `cloudflare/apps/mobile/src/components/Table.tsx` (`paused` on `SeatInfo`)
- Test: `cloudflare/apps/mobile/src/components/__tests__/components.test.tsx`, and the match screen's test file if one exists (`grep -rln "match/\[id\]" cloudflare/apps/mobile/src --include=*.test.tsx`)

**Interfaces:**
- Consumes: the same helpers as Task 11; `api.play('live')` (the same shared client), `api.leaveMatch`.

- [ ] **Step 1: Write the failing tests**

Mirror Task 11's five tests with the mobile harness (`render` from `@testing-library/react-native`, `getByText` / `findByText`). For `Table.tsx`:
```tsx
it('marks a paused seat as waiting', () => {
  const { getByText } = render(<Table {...tableProps({ seats: [{ ...seatInfo('p2'), clock: '0:00', paused: true }] })} />);
  expect(getByText('Waiting…')).toBeTruthy();
});
```
(use the file's existing props builder.)

- [ ] **Step 2: Run to see them fail**

Run: `cd cloudflare && npm test -w apps/mobile`
Expected: FAIL.

- [ ] **Step 3: Implement**

The same seven changes as Task 11 Step 3, in `[id].tsx`:
- `role`/`viewerId`/`watching` computed the same way; the existing `describeMatchFor` helper at `[id].tsx:731` takes `viewerId`.
- Bumped: effect calls `api.play('live')`, then `router.replace(`/match/${found.id}`)`; a **Find another** `Pressable` on failure; skip the deleted-match toast when bumped.
- Replaced panel with **Back to lobby** (`router.replace('/')`).
- Claimant: hide `Hand`, bidding/trump/ready controls and the autopilot bar; show the claim text and a **Cancel** `Pressable` in the hand's place, styled like the autopilot bar.
- **Leave game** in the match's actions, with `Alert.alert('Leave this game?', 'A bot takes your seat.', [{ text: 'Stay', style: 'cancel' }, { text: 'Leave', style: 'destructive', onPress: () => leaveMutation.mutate() }])`.
- Seat-change toasts through the app's existing toast helper (`ToastHost`'s `showToast` or whatever `[id].tsx` already calls for the "dealt" toast).
- `SeatInfo.paused?: boolean`; `Table.tsx` renders `<Text style={styles.seatClock}>Waiting…</Text>` beside the clock when set.

- [ ] **Step 4: Run the mobile suite**

Run: `cd cloudflare && npm test -w apps/mobile && npm run typecheck -w apps/mobile`
Expected: PASS.

- [ ] **Step 5: Look at it**

Use the `mobile-emulator` skill: open an Over the table game with bots on the emulator, then claim a seat from the web app with another account; check the claim bar, the toast, Leave game's alert, and a replaced player's panel.

- [ ] **Step 6: Commit**

```bash
git add cloudflare/apps/mobile
git commit -m "feat(mobile): watch a game while waiting for a seat, Leave game, and seat-change toasts"
```

---

### Task 13: Whole-branch check

- [ ] **Step 1: Everything**

Run: `cd cloudflare && npm run typecheck && npm test && npm run lint`
Expected: all PASS. Report any failure with its output; don't commit over one.

- [ ] **Step 2: Spec walk-through**

Read the spec's **Success looks like** and **Testing** lists; for each line name the test (file and name) that covers it. Anything without one gets a test in the owning task's file before finishing.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A cloudflare
git commit -m "test: cover the rest of the Over the table spec"
```
