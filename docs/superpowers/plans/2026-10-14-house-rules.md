# House Rules for Custom Matches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the creator of a Custom Match pick house rules (Low, Plunge, all-pass behaviour, marks to win), enforced by the rules engine and the bots, and shown in the lobby row and on the match screen.

**Architecture:** A `HouseRules` value lives on `MatchState.rules` and is copied onto every `Game.rules` it deals, so the existing `Game`-only functions (`availableBids`, `availableTrumps`, the bot) read it without signature changes. Absent rules mean today's defaults. A redeal is two pure engine steps (`needsRedeal`, `redeal`) composed by one worker helper. The lobby gets a nullable `rules` JSON column.

**Tech Stack:** TypeScript, Vitest (rules, bot, client, web, worker via `@cloudflare/vitest-pool-workers`), Jest (mobile), Hono, Cloudflare Durable Objects and D1, React (web), React Native/Expo (mobile).

**Spec:** `docs/superpowers/specs/2026-10-14-house-rules-design.md`

All paths below are relative to `cloudflare/`. Run every command from `cloudflare/`.

## Global Constraints

- House rules only on Custom Match (`POST /api/matches`). Live, Async (`/api/matchmaking`) and Play vs bots (`/api/matches/bots`) never take or store rules.
- `HouseRules = { low: 'off' | 'on' | 'forcedOnly'; plunge: boolean; allPass: 'forceLast' | 'redeal'; marksToWin: number }`, defaults `{ low: 'on', plunge: true, allPass: 'forceLast', marksToWin: 7 }`.
- `marksToWin` is an integer from 1 to 21.
- `low: 'forcedOnly'` with `allPass: 'redeal'` is invalid (rejected by the server, prevented by the form).
- Low is a trump choice, never a bid, and always needs a winning bid of at least 42, under every setting.
- A redeal keeps `firstActionBy`: the same player opens again. No marks are scored for it.
- A match or game stored without `rules` behaves exactly as today.
- No Sevens, no Splash, no points scoring, no lay over, no stats changes.
- Labels (exact text): `No Low`, `Low only when forced`, `No Plunge`, `Redeal on all pass`, `To N marks` (`To 1 mark` for 1). Default settings produce no labels.
- PR title convention (release-please): `feat: ...`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Installed mobile builds create custom matches with no request body.** `POST /api/matches` with no body must still return 201 on default rules (the existing `readBody` would 400). Test in Task 5.
2. **A player who outbid others then names Low under `forcedOnly`.** Only the player whose three opponents *all passed* may go Low; a normal winning bidder at 42+ may not. Test in Task 2.
3. **A rematch or the next hand silently dropping the rules.** Every new `Game` (next hand, redeal, rematch) carries `match.rules`. Tests in Tasks 1 and 3.
4. **A player's hand changing under them with no explanation after a redeal.** The new game is flagged `redealt: true` and both apps say so during bidding. Tests in Tasks 3, 8 and 9.
5. **A 21-mark tally overflowing a phone-width scoreboard.** The tally wraps. Checked in Task 9 on the emulator.

---

### Task 1: HouseRules type, validation, and carrying rules through the match

**Files:**
- Create: `packages/rules/src/houseRules.ts`
- Create: `packages/rules/src/houseRules.test.ts`
- Modify: `packages/rules/src/game.ts` (the `Game` interface)
- Modify: `packages/rules/src/matchEngine.ts` (`MatchState`, `createMatch`, `patchPlayerReady`, `createRematch`)
- Modify: `packages/rules/src/index.ts`
- Test: `packages/rules/src/matchEngine.test.ts`

**Interfaces:**
- Produces:
  - `type LowRule = 'off' | 'on' | 'forcedOnly'`, `type AllPassRule = 'forceLast' | 'redeal'`
  - `interface HouseRules { low: LowRule; plunge: boolean; allPass: AllPassRule; marksToWin: number }`
  - `DEFAULT_HOUSE_RULES: HouseRules`, `MIN_MARKS_TO_WIN = 1`, `MAX_MARKS_TO_WIN = 21`
  - `houseRules(x: { rules?: Partial<HouseRules> }): HouseRules`
  - `isDefaultHouseRules(rules: Partial<HouseRules> | undefined): boolean`
  - `assertValidHouseRules(input: unknown): HouseRules` (throws `ValidationError`)
  - `Game.rules?: HouseRules`, `Game.redealt?: true`, `MatchState.rules?: HouseRules`
  - `createMatch(firstPlayerId: string, mode?: MatchMode, rules?: HouseRules): MatchState`

- [ ] **Step 1: Write the failing tests**

Create `packages/rules/src/houseRules.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_HOUSE_RULES, assertValidHouseRules, houseRules, isDefaultHouseRules } from './houseRules';
import { ValidationError } from './errors';

describe('houseRules', () => {
  it('is the defaults when nothing is stored', () => {
    expect(houseRules({})).toEqual({ low: 'on', plunge: true, allPass: 'forceLast', marksToWin: 7 });
    expect(DEFAULT_HOUSE_RULES).toEqual({ low: 'on', plunge: true, allPass: 'forceLast', marksToWin: 7 });
  });

  it('fills in whatever is missing', () => {
    expect(houseRules({ rules: { plunge: false } })).toEqual({ ...DEFAULT_HOUSE_RULES, plunge: false });
  });
});

describe('isDefaultHouseRules', () => {
  it('is true for nothing, an empty object, or the defaults spelled out', () => {
    expect(isDefaultHouseRules(undefined)).toBe(true);
    expect(isDefaultHouseRules({})).toBe(true);
    expect(isDefaultHouseRules({ ...DEFAULT_HOUSE_RULES })).toBe(true);
  });

  it('is false when any setting differs', () => {
    expect(isDefaultHouseRules({ marksToWin: 5 })).toBe(false);
    expect(isDefaultHouseRules({ low: 'off' })).toBe(false);
  });
});

describe('assertValidHouseRules', () => {
  it('fills in defaults for a partial object', () => {
    expect(assertValidHouseRules({ low: 'off' })).toEqual({ ...DEFAULT_HOUSE_RULES, low: 'off' });
    expect(assertValidHouseRules({})).toEqual(DEFAULT_HOUSE_RULES);
  });

  it('accepts every valid combination it should', () => {
    expect(assertValidHouseRules({ low: 'forcedOnly', plunge: false, allPass: 'forceLast', marksToWin: 21 })).toEqual({
      low: 'forcedOnly', plunge: false, allPass: 'forceLast', marksToWin: 21,
    });
    expect(assertValidHouseRules({ allPass: 'redeal', marksToWin: 1 }).marksToWin).toBe(1);
  });

  it.each([
    ['not an object', 'rules'],
    ['an array', []],
    ['null', null],
    ['an unknown low', { low: 'sometimes' }],
    ['a non-boolean plunge', { plunge: 'yes' }],
    ['an unknown allPass', { allPass: 'shrug' }],
    ['marksToWin 0', { marksToWin: 0 }],
    ['marksToWin 22', { marksToWin: 22 }],
    ['a fractional marksToWin', { marksToWin: 6.5 }],
    ['a string marksToWin', { marksToWin: '7' }],
    ['forcedOnly with redeal', { low: 'forcedOnly', allPass: 'redeal' }],
  ])('rejects %s', (_, input) => {
    expect(() => assertValidHouseRules(input)).toThrow(ValidationError);
  });
});
```

Append to `packages/rules/src/matchEngine.test.ts` (it already has `fullDeck`, `baseMatch`, `baseGame` and imports `createMatch`, `addPlayer`, `patchPlayerReady`, `createRematch`, `Teams`):

```ts
describe('house rules on a match', () => {
  const rules = { low: 'off', plunge: false, allPass: 'forceLast', marksToWin: 5 } as const;

  it('stores the rules on the match and its first hand', () => {
    const match = createMatch('p1', 'custom', rules);
    expect(match.rules).toEqual(rules);
    expect(match.currentGame.rules).toEqual(rules);
  });

  it('stores nothing when no rules are given, so stored matches look as they did', () => {
    const match = createMatch('p1');
    expect(match).not.toHaveProperty('rules');
    expect(match.currentGame).not.toHaveProperty('rules');
  });

  it('keeps the rules on the first deal', () => {
    let match = createMatch('p1', 'custom', rules);
    match = addPlayer(match, 'p2', Teams.TeamA);
    match = addPlayer(match, 'p3', Teams.TeamB);
    match = addPlayer(match, 'p4', Teams.TeamB, fullDeck());
    expect(match.currentGame.rules).toEqual(rules);
  });

  it('copies the rules onto the next hand', () => {
    // TeamA (p1/p3) bid 30 and took a 31-point trick: a decided hand, all ready but p4.
    const decided = baseMatch({
      rules,
      currentGame: baseGame({
        rules,
        bid: Bid.Thirty,
        biddingPlayerId: 'p1',
        trump: Suit.Sixes,
        hands: baseGame().hands.map((h) => (h.playerId === 'p1' ? { ...h, bid: Bid.Thirty } : { ...h, bid: Bid.Pass })),
        tricks: [{
          playerId: 'p1',
          team: Teams.TeamA,
          suit: Suit.Fives,
          dominoes: [createDomino(5, 5), createDomino(6, 4), createDomino(5, 0), createDomino(4, 1)],
        }],
      }),
      players: fourPlayers().map((p) => ({ ...p, ready: p.playerId !== 'p4' })),
    });
    const next = patchPlayerReady(decided, 'p4', true, fullDeck());
    expect(next.currentGame.id).not.toBe('g1');
    expect(next.currentGame.rules).toEqual(rules);
  });

  it('keeps the rules on a rematch', () => {
    const previous = baseMatch({ rules, winningTeam: Teams.TeamA });
    const rematch = createRematch('m2', previous, fullDeck());
    expect(rematch.rules).toEqual(rules);
    expect(rematch.currentGame.rules).toEqual(rules);
  });
});
```

If `fourPlayers` is not in scope at the bottom of the file, it is: it's a top-level function in `matchEngine.test.ts`.

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npm test -w @fortytwo/rules -- houseRules matchEngine`
Expected: FAIL. `houseRules.test.ts` can't resolve `./houseRules`; the matchEngine block fails because `createMatch` ignores the third argument.

- [ ] **Step 3: Implement**

Create `packages/rules/src/houseRules.ts`:

```ts
// The house rules a custom table's creator picks (#117). Stored on the match and copied onto each
// hand it deals, so the guards that only see a `Game` (validation.ts, the bot) can read them.
// Absent means these defaults, which are the rules every other mode plays by.
import { ValidationError } from './errors';

export type LowRule = 'off' | 'on' | 'forcedOnly';
export type AllPassRule = 'forceLast' | 'redeal';

export interface HouseRules {
  // Whether the winning bidder may name a Low trump: never, at any bid of 42+, or only when they
  // were forced to bid (the other three all passed). Low always needs a bid of at least 42.
  low: LowRule;
  plunge: boolean;
  // When the first three pass: the last player must bid, or (redeal) they may pass too and new
  // hands are dealt, opened by the same player.
  allPass: AllPassRule;
  marksToWin: number;
}

export const DEFAULT_HOUSE_RULES: HouseRules = { low: 'on', plunge: true, allPass: 'forceLast', marksToWin: 7 };
export const MIN_MARKS_TO_WIN = 1;
export const MAX_MARKS_TO_WIN = 21;

export function houseRules(x: { rules?: Partial<HouseRules> }): HouseRules {
  return { ...DEFAULT_HOUSE_RULES, ...x.rules };
}

export function isDefaultHouseRules(rules: Partial<HouseRules> | undefined): boolean {
  const r = houseRules({ rules });
  return (
    r.low === DEFAULT_HOUSE_RULES.low &&
    r.plunge === DEFAULT_HOUSE_RULES.plunge &&
    r.allPass === DEFAULT_HOUSE_RULES.allPass &&
    r.marksToWin === DEFAULT_HOUSE_RULES.marksToWin
  );
}

const LOW_RULES: LowRule[] = ['off', 'on', 'forcedOnly'];
const ALL_PASS_RULES: AllPassRule[] = ['forceLast', 'redeal'];

function invalid(detail: string): never {
  throw new ValidationError('Invalid house rules', detail);
}

// Checks rules from a request, filling in defaults for anything left out.
export function assertValidHouseRules(input: unknown): HouseRules {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid('House rules must be an object.');
  const given = input as Record<string, unknown>;
  const rules = { ...DEFAULT_HOUSE_RULES, ...given } as Record<string, unknown>;

  if (!LOW_RULES.includes(rules.low as LowRule)) invalid(`\`low\` must be one of ${LOW_RULES.join(', ')}.`);
  if (typeof rules.plunge !== 'boolean') invalid('`plunge` must be true or false.');
  if (!ALL_PASS_RULES.includes(rules.allPass as AllPassRule)) {
    invalid(`\`allPass\` must be one of ${ALL_PASS_RULES.join(', ')}.`);
  }
  const marks = rules.marksToWin;
  if (typeof marks !== 'number' || !Number.isInteger(marks) || marks < MIN_MARKS_TO_WIN || marks > MAX_MARKS_TO_WIN) {
    invalid(`\`marksToWin\` must be a whole number from ${MIN_MARKS_TO_WIN} to ${MAX_MARKS_TO_WIN}.`);
  }
  if (rules.low === 'forcedOnly' && rules.allPass === 'redeal') {
    invalid('Nobody is ever forced to bid when everyone passing redeals, so Low can\'t be only for a forced bidder.');
  }

  return {
    low: rules.low as LowRule,
    plunge: rules.plunge as boolean,
    allPass: rules.allPass as AllPassRule,
    marksToWin: marks as number,
  };
}
```

In `packages/rules/src/game.ts`, add `import type { HouseRules } from './houseRules';` and two fields at the end of `Game`:

```ts
  // The match's house rules (houseRules.ts), copied onto each hand dealt; absent means defaults.
  rules?: HouseRules;
  // This hand was dealt again because everyone passed (house rule `allPass: 'redeal'`).
  redealt?: true;
```

In `packages/rules/src/matchEngine.ts`:

1. `import type { HouseRules } from './houseRules';`
2. Add to `MatchState` after `bumped?`:
```ts
  // The house rules a custom table was created with (houseRules.ts). Absent means the defaults.
  rules?: HouseRules;
```
3. Add a helper above `createMatch`:
```ts
// The rules field to put on a new hand: the match's own, or nothing for a match without any.
function rulesOf(match: { rules?: HouseRules }): { rules?: HouseRules } {
  return match.rules ? { rules: match.rules } : {};
}
```
4. Change `createMatch`:
```ts
export function createMatch(firstPlayerId: string, mode: MatchMode = 'custom', rules?: HouseRules): MatchState {
```
   add `...(rules ? { rules } : {}),` as the last property of the `game` object literal, and `...(rules ? { rules } : {}),` as the last property of the returned match.
5. In `patchPlayerReady`, add `...rulesOf(match),` as the last property of the new `currentGame` literal.
6. In `createRematch`, add `...rulesOf(previous),` as the last property of the `currentGame` literal and `...rulesOf(previous),` after the `hadBots` spread in the returned match.

In `packages/rules/src/index.ts`, add:

```ts
export type { HouseRules, LowRule, AllPassRule } from './houseRules';
export {
  DEFAULT_HOUSE_RULES,
  MIN_MARKS_TO_WIN,
  MAX_MARKS_TO_WIN,
  houseRules,
  isDefaultHouseRules,
  assertValidHouseRules,
} from './houseRules';
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm test -w @fortytwo/rules && npm run typecheck -w @fortytwo/rules`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/rules/src
git commit -m "feat(rules): house rules carried on a match and its hands"
```

---

### Task 2: Low, Plunge and all-pass rules in bidding and trump

**Files:**
- Modify: `packages/rules/src/validation.ts` (`assertValidBid`, `availableBids`, `availableTrumps`, `assertValidTrump`, new `lowAllowedIfWon`)
- Modify: `packages/rules/src/index.ts`
- Test: `packages/rules/src/validation.test.ts`

**Interfaces:**
- Consumes: `houseRules(game)` and `Game.rules` from Task 1.
- Produces: `lowAllowedIfWon(game: Game, playerId: string): boolean`. True when the `low` rule would let `playerId` name Low if their bid won: `'on'` always, `'off'` never, `'forcedOnly'` only when every other hand has bid `Pass`. It does **not** check the 42 minimum; that depends on the bid, and `availableTrumps` and the bot apply it.

- [ ] **Step 1: Write the failing tests**

Look at the top of `packages/rules/src/validation.test.ts` for its game fixture. Then append the block below. It builds its own games so it doesn't depend on that fixture.

```ts
import { createDomino } from './domino';
import { LOW_TRUMPS } from './suit';
import { lowAllowedIfWon, availableBids, availableTrumps, assertValidBid, assertValidTrump } from './validation';
import type { HouseRules } from './houseRules';
import type { Game } from './game';

// Bidding order p1, p2, p3, p4. `bids` are the bids already made, in seat order.
function biddingGame(bids: (Bid | null)[], rules?: Partial<HouseRules>, extra: Partial<Game> = {}): Game {
  const ids = ['p1', 'p2', 'p3', 'p4'];
  const hands = ids.map((playerId, i) => ({
    playerId,
    team: i % 2 === 0 ? Teams.TeamA : Teams.TeamB,
    dominoes: [] as ReturnType<typeof createDomino>[],
    bid: bids[i] ?? null,
  }));
  const high = bids.reduce<{ bid: Bid | null; by: string | null }>(
    (best, b, i) => (b !== null && b !== Bid.Pass && (best.bid === null || b > best.bid) ? { bid: b, by: ids[i] } : best),
    { bid: null, by: null }
  );
  return {
    id: 'g1', name: 'Game 1', firstActionBy: 'p1', bid: high.bid, biddingPlayerId: high.by, trump: null,
    currentPlayerId: ids[bids.filter((b) => b !== null).length] ?? high.by,
    hands, currentTrick: { dominoes: [null, null, null, null], suit: null, playerId: null, team: null } as Game['currentTrick'],
    tricks: [],
    ...(rules ? { rules: { low: 'on', plunge: true, allPass: 'forceLast', marksToWin: 7, ...rules } as HouseRules } : {}),
    ...extra,
  };
}

const FOUR_DOUBLES = [createDomino(0, 0), createDomino(1, 1), createDomino(2, 2), createDomino(3, 3)];

describe('house rules: all pass', () => {
  it('forces the last bidder under the default rules', () => {
    const game = biddingGame([Bid.Pass, Bid.Pass, Bid.Pass, null]);
    expect(availableBids(game, 'p4')).not.toContain(Bid.Pass);
    expect(() => assertValidBid(game, 'p4', Bid.Pass)).toThrow(ValidationError);
  });

  it('lets the last bidder pass under redeal', () => {
    const game = biddingGame([Bid.Pass, Bid.Pass, Bid.Pass, null], { allPass: 'redeal' });
    expect(availableBids(game, 'p4')[0]).toBe(Bid.Pass);
    expect(() => assertValidBid(game, 'p4', Bid.Pass)).not.toThrow();
  });
});

describe('house rules: plunge', () => {
  it('offers Plunge with four doubles by default', () => {
    const game = biddingGame([null, null, null, null]);
    game.hands[0].dominoes = FOUR_DOUBLES;
    expect(availableBids(game, 'p1')).toContain(Bid.Plunge);
  });

  it('never offers Plunge when it is off', () => {
    const game = biddingGame([null, null, null, null], { plunge: false });
    game.hands[0].dominoes = FOUR_DOUBLES;
    expect(availableBids(game, 'p1')).not.toContain(Bid.Plunge);
    expect(() => assertValidBid(game, 'p1', Bid.Plunge)).toThrow(ValidationError);
  });
});

describe('house rules: low', () => {
  it('offers Low at 42+ when on, as today', () => {
    const game = biddingGame([Bid.FortyTwo, Bid.Pass, Bid.Pass, Bid.Pass], { low: 'on' });
    expect(availableTrumps(game)).toEqual(expect.arrayContaining([...LOW_TRUMPS]));
  });

  it('never offers Low when off, with a reason', () => {
    const game = biddingGame([Bid.Pass, Bid.Pass, Bid.Pass, Bid.EightyFour], { low: 'off' });
    expect(availableTrumps(game).some((s) => LOW_TRUMPS.includes(s as (typeof LOW_TRUMPS)[number]))).toBe(false);
    expect(availableTrumps(game)).toContain(Suit.None);
    expect(() => assertValidTrump(game, Suit.Low)).toThrow(/isn't played at this table/);
  });

  it('offers Low to a forced bidder at 42+ under forcedOnly', () => {
    const game = biddingGame([Bid.Pass, Bid.Pass, Bid.Pass, Bid.FortyTwo], { low: 'forcedOnly' });
    expect(availableTrumps(game)).toEqual(expect.arrayContaining([...LOW_TRUMPS]));
  });

  it('still needs 42 from a forced bidder under forcedOnly', () => {
    const game = biddingGame([Bid.Pass, Bid.Pass, Bid.Pass, Bid.Thirty], { low: 'forcedOnly' });
    expect(availableTrumps(game)).not.toContain(Suit.Low);
    expect(() => assertValidTrump(game, Suit.Low)).toThrow(/needs a bid of at least 42/);
  });

  it('refuses Low to a bidder who outbid someone under forcedOnly', () => {
    const game = biddingGame([Bid.Thirty, Bid.Pass, Bid.Pass, Bid.FortyTwo], { low: 'forcedOnly' });
    expect(availableTrumps(game)).not.toContain(Suit.Low);
    expect(() => assertValidTrump(game, Suit.Low)).toThrow(/only for a player forced to bid/);
  });

  it('refuses Low to an opener whose bid stood under forcedOnly', () => {
    const game = biddingGame([Bid.FortyTwo, Bid.Pass, Bid.Pass, Bid.Pass], { low: 'forcedOnly' });
    expect(availableTrumps(game)).not.toContain(Suit.Low);
  });
});

describe('lowAllowedIfWon', () => {
  it('follows the low rule, and under forcedOnly whether the other three passed', () => {
    expect(lowAllowedIfWon(biddingGame([null, null, null, null]), 'p1')).toBe(true);
    expect(lowAllowedIfWon(biddingGame([null, null, null, null], { low: 'off' }), 'p1')).toBe(false);
    expect(lowAllowedIfWon(biddingGame([null, null, null, null], { low: 'forcedOnly' }), 'p1')).toBe(false);
    expect(lowAllowedIfWon(biddingGame([Bid.Pass, Bid.Pass, Bid.Pass, null], { low: 'forcedOnly' }), 'p4')).toBe(true);
    expect(lowAllowedIfWon(biddingGame([Bid.Pass, Bid.Thirty, Bid.Pass, null], { low: 'forcedOnly' }), 'p4')).toBe(false);
  });
});
```

Merge these imports with the file's existing ones instead of duplicating them (`Bid`, `Suit`, `Teams` and `ValidationError` are almost certainly already imported). If `Trick` has a different shape, build `currentTrick` with `createTrick()` from `./trick` instead.

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npm test -w @fortytwo/rules -- validation`
Expected: FAIL. `lowAllowedIfWon` isn't exported, and the redeal, plunge-off and low-off cases fail.

- [ ] **Step 3: Implement**

In `packages/rules/src/validation.ts`, `import { houseRules } from './houseRules';` and then:

1. In `assertValidBid`, change the everyone-passed guard to:
```ts
  if (
    houseRules(game).allPass === 'forceLast' &&
    game.hands.filter((h) => h.bid === Bid.Pass).length === 3 &&
    bid === Bid.Pass
  ) {
```
2. In `availableBids`, read `const rules = houseRules(game);` at the top and change:
```ts
  if (rules.allPass === 'redeal' || game.hands.filter((h) => h.bid === Bid.Pass).length < 3) bids.push(Bid.Pass);
```
```ts
  if (rules.plunge && doubles >= 4 && (current ?? Bid.Pass) < Bid.FourMarks) bids.push(Bid.Plunge);
```
   Update the comment above `availableBids` to mention the redeal and Plunge rules.
3. Add, above `availableTrumps`:
```ts
// Whether the house rules let `playerId` name Low if their bid wins: under 'forcedOnly' only when
// the other three all passed, i.e. they were the forced last bidder. The 42 minimum is separate -
// it depends on the bid (availableTrumps; the bot checks it per bid).
export function lowAllowedIfWon(game: Game, playerId: string): boolean {
  const { low } = houseRules(game);
  if (low !== 'forcedOnly') return low === 'on';
  return game.hands.filter((h) => h.playerId !== playerId).every((h) => h.bid === Bid.Pass);
}
```
4. Replace `availableTrumps`:
```ts
export function availableTrumps(game: Game): Suit[] {
  if (game.bid === Bid.Plunge) return [...NAMED_SUITS, Suit.None];
  if (game.bid === null || game.bid < Bid.FortyTwo) return [...NAMED_SUITS];
  const low = game.biddingPlayerId !== null && lowAllowedIfWon(game, game.biddingPlayerId);
  return low ? [...NAMED_SUITS, Suit.None, ...LOW_TRUMPS] : [...NAMED_SUITS, Suit.None];
}
```
   Add a line to its comment: "and Low only as the house rules allow (`lowAllowedIfWon`)."
5. Replace the message selection in `assertValidTrump`:
```ts
export function assertValidTrump(game: Game, suit: Suit): void {
  if (availableTrumps(game).includes(suit)) return;
  const atLeast42 = game.bid !== null && game.bid >= Bid.FortyTwo;
  throw new ValidationError(
    'Invalid Trump',
    game.bid === Bid.Plunge && isLow(suit)
      ? "A Plunge has to take every trick, so it can't go Low"
      : isLow(suit) && atLeast42 && houseRules(game).low === 'off'
        ? "Low isn't played at this table"
        : isLow(suit) && atLeast42
          ? 'At this table Low is only for a player forced to bid'
          : suit === Suit.None || isLow(suit)
            ? `<code>${suitToPrettyString(suit)}</code> needs a bid of at least 42`
            : "That isn't a trump you can call"
  );
}
```
6. Export `lowAllowedIfWon` from `packages/rules/src/index.ts` in the `./validation` export list.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm test -w @fortytwo/rules && npm run typecheck -w @fortytwo/rules`
Expected: all PASS. The existing bidding and trump tests still pass unchanged, since the defaults are today's rules.

- [ ] **Step 5: Commit**

```bash
git add packages/rules/src
git commit -m "feat(rules): Low, Plunge and all-pass house rules in bidding"
```

---

### Task 3: Redeal on all pass, and marks to win

**Files:**
- Modify: `packages/rules/src/matchEngine.ts` (`placeBid`, new `needsRedeal`, new `redeal`, `playDomino`)
- Modify: `packages/rules/src/index.ts`
- Test: `packages/rules/src/matchEngine.test.ts`

**Interfaces:**
- Consumes: `houseRules`, `Game.rules`, `Game.redealt`, `rulesOf` (internal) from Task 1; the redeal-allows-Pass behaviour from Task 2.
- Produces:
  - `needsRedeal(match: MatchState): boolean`: all four hands bid and every bid is `Pass`.
  - `redeal(match: MatchState, dealOrder: Domino[]): MatchState`: new hands to the same seats, bids cleared, the same `firstActionBy` opening, `redealt: true`, the same `name`, a new `id`. Throws `Error` if `!needsRedeal(match)`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/rules/src/matchEngine.test.ts`, merging imports (`needsRedeal`, `redeal` from `./matchEngine`; `Bid`, `Suit` are already imported):

```ts
describe('redeal on all pass', () => {
  const rules = { low: 'on', plunge: true, allPass: 'redeal', marksToWin: 7 } as const;

  // p1..p4 seated First..Fourth, so bidding runs p1, p2, p3, p4. p2 opens to show the opener is kept.
  function dealt(): MatchState {
    return baseMatch({
      rules,
      currentGame: baseGame({
        rules,
        firstActionBy: 'p2',
        currentPlayerId: 'p2',
        hands: baseGame().hands.map((h, i) => ({ ...h, dominoes: fullDeck().slice(i * 7, i * 7 + 7) })),
      }),
    });
  }

  function allPass(match: MatchState): MatchState {
    for (const id of ['p2', 'p3', 'p4', 'p1']) match = placeBid(match, id, Bid.Pass);
    return match;
  }

  it('leaves a hand where all four passed waiting for a redeal, with nobody to act', () => {
    const match = allPass(dealt());
    expect(needsRedeal(match)).toBe(true);
    expect(match.currentGame.currentPlayerId).toBeNull();
    expect(() => setTrump(match, 'p1', Suit.Sixes)).toThrow(ValidationError);
    expect(() => playDomino(match, 'p2', fullDeck()[7])).toThrow(ValidationError);
  });

  it('is not due while anyone has bid or is still to bid', () => {
    expect(needsRedeal(dealt())).toBe(false);
    expect(needsRedeal(placeBid(dealt(), 'p2', Bid.Pass))).toBe(false);
  });

  it('deals new hands opened by the same player, keeping the rules and scoring nothing', () => {
    const before = allPass(dealt());
    const reversed = [...fullDeck()].reverse();
    const after = redeal(before, reversed);

    expect(after.currentGame.firstActionBy).toBe('p2');
    expect(after.currentGame.currentPlayerId).toBe('p2');
    expect(after.currentGame.hands.every((h) => h.bid === null)).toBe(true);
    expect(after.currentGame.hands.find((h) => h.playerId === 'p1')!.dominoes).toEqual(reversed.slice(0, 7));
    expect(after.currentGame.bid).toBeNull();
    expect(after.currentGame.biddingPlayerId).toBeNull();
    expect(after.currentGame.redealt).toBe(true);
    expect(after.currentGame.rules).toEqual(rules);
    expect(after.currentGame.name).toBe(before.currentGame.name);
    expect(after.currentGame.id).not.toBe(before.currentGame.id);
    expect(after.games).toEqual({});
    expect(needsRedeal(after)).toBe(false);
  });

  it('refuses to redeal a hand that is not due one', () => {
    expect(() => redeal(dealt(), fullDeck())).toThrow();
  });
});

describe('marks to win', () => {
  // The fixture of the existing "keeps accepting plays after the match is won" test: TeamA's
  // deciding trick (31 points on a 30 bid) is already down but the hand isn't filed yet, so p1's
  // next play files it and checks for a match winner. `readyToPlay` is that file's helper.
  const decidingTrick: Trick = {
    playerId: 'p1',
    team: Teams.TeamA,
    suit: Suit.Fives,
    dominoes: [createDomino(5, 5), createDomino(6, 4), createDomino(5, 0), createDomino(4, 1)],
  };

  function withEarlierWins(marksToWin: number, earlier: number): MatchState {
    const match = readyToPlay({ tricks: [decidingTrick] });
    const rules = { low: 'on', plunge: true, allPass: 'forceLast', marksToWin } as const;
    const earlierWins = Array.from({ length: earlier }, (_, i) => ({ ...match.currentGame, id: `won-${i}` }));
    return { ...match, rules, games: { [Teams.TeamA]: earlierWins } };
  }

  it('wins the match at the house marksToWin instead of 7', () => {
    const match = playDomino(withEarlierWins(3, 2), 'p1', createDomino(6, 6));
    expect(matchScores(match)[Teams.TeamA]).toBe(3);
    expect(match.winningTeam).toBe(Teams.TeamA);
  });

  it('does not end the match at 7 when marksToWin is higher', () => {
    const match = playDomino(withEarlierWins(9, 6), 'p1', createDomino(6, 6));
    expect(matchScores(match)[Teams.TeamA]).toBe(7);
    expect(match.winningTeam).toBeNull();
  });

  it('still ends at 7 for a match stored without rules', () => {
    const { rules: _, ...plain } = withEarlierWins(9, 6);
    expect(playDomino(plain, 'p1', createDomino(6, 6)).winningTeam).toBe(Teams.TeamA);
  });
});
```

Put this block **inside** `describe('playDomino', ...)` (at its end): `readyToPlay` is local to that describe. `Trick`, `createDomino` and `matchScores` are already imported.

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npm test -w @fortytwo/rules -- matchEngine`
Expected: FAIL. `needsRedeal` and `redeal` aren't exported, and the match is won at 7 regardless of `marksToWin`.

- [ ] **Step 3: Implement**

In `packages/rules/src/matchEngine.ts`:

1. `import { houseRules } from './houseRules';`
2. In `placeBid`, make the all-passed case explicit. Replace the `if / else if / else` that sets `currentPlayerId` with:
```ts
  let currentPlayerId: string | null;

  if (hands.some((h) => h.bid === null)) {
    currentPlayerId = selectNextPlayer(
      match.currentGame.currentPlayerId!,
      biddingPlayerId,
      match.currentGame.trump,
      match.players
    );
  } else if (biddingPlayerId === null) {
    // Everyone passed (only possible under the redeal house rule): nobody acts until `redeal`.
    currentPlayerId = null;
  } else if (gameBid === Bid.Plunge) {
```
   (keep the Plunge branch and the final `else` as they are). Extend the comment above `placeBid` with: "Under the redeal house rule all four may pass, which leaves the hand waiting for `redeal`."
3. Add after `placeBid`:
```ts
// Every hand has bid and all of them passed - only possible under the redeal house rule. The
// caller deals again with `redeal` in the same update, so this state is never stored.
export function needsRedeal(match: MatchState): boolean {
  const hands = match.currentGame.hands;
  return hands.length === 4 && hands.every((h) => h.bid === Bid.Pass);
}

// Deals new hands to the same seats after everyone passed. The same player opens again, and the
// hand keeps its name: it's the same hand of the match, dealt again.
export function redeal(match: MatchState, dealOrder: Domino[]): MatchState {
  if (!needsRedeal(match)) throw new Error('Only a hand everyone passed can be redealt');
  const last = match.currentGame;
  const hands = dealHands(
    last.hands.map((h) => ({ playerId: h.playerId, team: h.team, dominoes: [], bid: null })),
    match.players,
    dealOrder
  );
  const currentGame: Game = {
    id: crypto.randomUUID(),
    name: last.name,
    firstActionBy: last.firstActionBy,
    bid: null,
    biddingPlayerId: null,
    trump: null,
    currentPlayerId: last.firstActionBy,
    hands,
    currentTrick: createTrick(),
    tricks: [],
    dealtOn: now(),
    ...rulesOf(match),
    redealt: true,
  };
  return { ...match, currentGame, updatedOn: now() };
}
```
4. In `playDomino`, replace both `WINNING_SCORE` uses in the `matchWinningTeam` expression with a local:
```ts
  const marksToWin = houseRules(match).marksToWin;
```
   (`value >= marksToWin`). Update the comment above `playDomino` to say "reaches the match's marks to win (7 unless the house rules say otherwise)". Keep `export const WINNING_SCORE = 7;` and change its comment to `// Marks needed to win the match under the default rules (houseRules.ts).`

Leave `setTrump` and `playDomino` alone for the redeal guard: with `currentPlayerId` null, `assertActiveTurn` already refuses both, which the Step 1 test pins.

5. Export `needsRedeal` and `redeal` from `packages/rules/src/index.ts` in the `./matchEngine` list.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm test -w @fortytwo/rules && npm run typecheck -w @fortytwo/rules`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rules/src
git commit -m "feat(rules): redeal when everyone passes, and house marks to win"
```

---

### Task 4: Bot doesn't bid on Low strength when Low isn't allowed

**Files:**
- Modify: `packages/bot/src/bidding.ts` (`optionsFromTable`)
- Modify: `packages/bot/src/bot.ts` (`decideBid`)
- Create: `packages/bot/test/bidding.test.ts`

**Interfaces:**
- Consumes: `lowAllowedIfWon(game, playerId)` from Task 2.
- Produces: `optionsFromTable(table: BidTable, legal: number[], allowLow = true): Option[]`

- [ ] **Step 1: Write the failing test**

Create `packages/bot/test/bidding.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { chooseBid, optionsFromTable, type BidTable } from '../src/bidding';

// A hand that can only make a Low: every high and points probability is near zero, Low is near certain.
const lowOnly: BidTable = {
  points: Array.from({ length: 7 }, () => new Array(12).fill(0.01)),
  high: new Array(8).fill(0.01),
  low: [0.95, 0.9, 0.9],
  plunge: null,
};
const legal = [0, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 84];
const cfg = { makeThreshold: 0.6, overbidPartnerThreshold: 0.9 };
const ctx = { legal, partnerHolds: false, lastToBid: false };

describe('optionsFromTable', () => {
  it('values 42+ bids by Low when Low is allowed', () => {
    const options = optionsFromTable(lowOnly, legal);
    expect(options.some((o) => o.trump < -1)).toBe(true);
    expect(chooseBid(options, ctx, cfg).bid).toBeGreaterThanOrEqual(42);
  });

  it('leaves Low out when it is not allowed, so the bot passes a Low-only hand', () => {
    const options = optionsFromTable(lowOnly, legal, false);
    expect(options.some((o) => o.trump < -1)).toBe(false);
    expect(chooseBid(options, ctx, cfg).bid).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to make sure it fails**

Run: `npm test -w @fortytwo/bot -- bidding`
Expected: FAIL on the second test (the third argument is ignored, so Low options are present).

- [ ] **Step 3: Implement**

In `packages/bot/src/bidding.ts`:

```ts
// `allowLow` false (a house rule forbids this bidder from naming Low) leaves the Low options out,
// so a hand isn't bid up on Low strength it can't use.
export function optionsFromTable(table: BidTable, legal: number[], allowLow = true): Option[] {
```
and guard the Low line:
```ts
    if (allowLow) LOW_TRUMPS.forEach((t, i) => { for (const b of highBids) options.push({ bid: b, trump: t, pMake: table.low[i] }); });
```

In `packages/bot/src/bot.ts`, add `lowAllowedIfWon` to the `@fortytwo/rules` import, and in `decideBid`:

```ts
      return chooseBid(optionsFromTable(table(game, playerId), legal, lowAllowedIfWon(game, playerId)), ctx, cfg).bid as Bid;
```

`decideTrump` needs no change: it filters by `availableTrumps`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm test -w @fortytwo/bot && npm run typecheck -w @fortytwo/bot`
Expected: all PASS, including `bot.test.ts`'s fixture replay. Default rules pass `true`, so decisions are unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/bot
git commit -m "feat(bot): skip Low options when the house rules forbid Low"
```

---

### Task 5: Worker creates custom matches with rules, and redeals

**Files:**
- Modify: `apps/worker/src/requestBody.ts` (new `readOptionalBody`, new `houseRules` field reader)
- Modify: `apps/worker/src/routes/matches.ts` (`POST /`)
- Modify: `apps/worker/src/matchDO.ts` (`create`, `bid`)
- Create: `apps/worker/src/redeal.ts`
- Modify: `apps/worker/src/bots.ts` (`simple`, `ml`)
- Test: `apps/worker/test/matchDO.test.ts`, `apps/worker/test/routes.matches.test.ts`

**Interfaces:**
- Consumes: `assertValidHouseRules`, `HouseRules`, `ValidationError`, `placeBid`, `needsRedeal`, `redeal`, `shuffledDominoOrder` from `@fortytwo/rules`.
- Produces:
  - `MatchDO.create(firstPlayerId: string, matchId: string, mode?: MatchMode, rules?: HouseRules): Promise<MatchState>`
  - `bidAndMaybeRedeal(match: MatchState, playerId: string, bid: Bid): MatchState` in `apps/worker/src/redeal.ts`
  - `POST /api/matches` body `{ rules?: Partial<HouseRules> }`, optional

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/test/matchDO.test.ts` inside `describe('MatchDO RPC', ...)`:

```ts
  describe('house rules', () => {
    const rules = { low: 'on', plunge: true, allPass: 'redeal', marksToWin: 5 } as const;

    it('creates a custom match with the rules it was given', async () => {
      const stub = stubFor('house-rules-create');
      const match = await stub.create('p1', 'house-rules-create', 'custom', rules);
      expect(match.rules).toEqual(rules);
      expect(valueOf(await stub.getMatch()).currentGame.rules).toEqual(rules);
    });

    it('redeals in the same update when everyone passes, with the same opener', async () => {
      const stub = stubFor('house-rules-redeal');
      await stub.create('p1', 'house-rules-redeal', 'custom', rules);
      await stub.addPlayer('p2', Teams.TeamA);
      await stub.addPlayer('p3', Teams.TeamB);
      const dealt = valueOf(await stub.addPlayer('p4', Teams.TeamB, fullDeck()));
      const opener = dealt.currentGame.firstActionBy;

      let match = dealt;
      for (let i = 0; i < 4; i++) {
        match = valueOf(await stub.bid(match.currentGame.currentPlayerId!, 0));
      }

      expect(match.currentGame.redealt).toBe(true);
      expect(match.currentGame.firstActionBy).toBe(opener);
      expect(match.currentGame.currentPlayerId).toBe(opener);
      expect(match.currentGame.hands.every((h) => h.bid === null && h.dominoes.length === 7)).toBe(true);
      // And that is what was stored, not a half-way all-passed hand.
      expect(valueOf(await stub.getMatch()).currentGame.redealt).toBe(true);
    });
  });
```

In `apps/worker/test/routes.matches.test.ts`, add inside `describe('match routes', ...)`:

```ts
  describe('POST /api/matches house rules', () => {
    it('creates on the default rules with no body at all, as installed mobile builds send', async () => {
      const p1 = await signToken('p1');
      const res = await api('/api/matches', p1, { method: 'POST' });
      expect(res.status).toBe(201);
      expect(((await res.json()) as MatchState).rules).toBeUndefined();
    });

    it('creates with the rules sent, filling in defaults', async () => {
      const p1 = await signToken('p1');
      const res = await api('/api/matches', p1, { method: 'POST', body: JSON.stringify({ rules: { low: 'forcedOnly', marksToWin: 5 } }) });
      expect(res.status).toBe(201);
      expect(((await res.json()) as MatchState).rules).toEqual({ low: 'forcedOnly', plunge: true, allPass: 'forceLast', marksToWin: 5 });
    });

    it.each([
      [{ rules: { marksToWin: 30 } }],
      [{ rules: { low: 'forcedOnly', allPass: 'redeal' } }],
      [{ rules: 'yes' }],
    ])('refuses bad rules with a 400: %j', async (body) => {
      const p1 = await signToken('p1');
      const res = await api('/api/matches', p1, { method: 'POST', body: JSON.stringify(body) });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { title: string }).title).toBe('Invalid request');
    });
  });
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npm test -w @fortytwo/worker -- matchDO.test routes.matches`
Expected: FAIL. `create` ignores rules, four passes are refused (forceLast is applied because the rules aren't stored), and the body is ignored. If the worker tests fail to start at all on Node 26, switch to Node 25 (`nvm use 25.7`) and rerun. The memory notes this, but it isn't needed once Vitest 4 is on master.

- [ ] **Step 3: Implement**

`apps/worker/src/requestBody.ts`: add `assertValidHouseRules`, `ValidationError` and `type HouseRules` to the `@fortytwo/rules` import, then:

```ts
// A body that may be left out altogether: no body is an empty object. Anything sent must still be
// a JSON object. (POST /api/matches: installed mobile builds send no body.)
export async function readOptionalBody(c: Context): Promise<Body> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BadRequestError('The request body must be JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestError('The request body must be a JSON object.');
  }
  return body as Body;
}

// A custom table's house rules, or undefined when none were sent (the defaults).
export function houseRules(body: Body): HouseRules | undefined {
  if (body.rules === undefined) return undefined;
  try {
    return assertValidHouseRules(body.rules);
  } catch (error) {
    if (error instanceof ValidationError) throw new BadRequestError(error.detail ?? error.title);
    throw error;
  }
}
```

`apps/worker/src/routes/matches.ts`, `POST /`:

```ts
matches.post('/', async (c) => {
  const rules = field.houseRules(await field.readOptionalBody(c));
  const matchId = crypto.randomUUID();
  const match = await matchStub(c.env, matchId).create(c.get('user').sub, matchId, 'custom', rules);
```

`apps/worker/src/matchDO.ts`: add `type HouseRules` to the rules import and change `create`:

```ts
  async create(firstPlayerId: string, matchId: string, mode: MatchMode = 'custom', rules?: HouseRules): Promise<MatchState> {
    const match = { ...createMatch(firstPlayerId, mode, rules), id: matchId };
```

Create `apps/worker/src/redeal.ts`:

```ts
// A bid, and - under the redeal house rule - new hands when it was the fourth pass. One step, so
// the all-passed hand is never stored or broadcast, and a deck is only shuffled when it's dealt.
import { needsRedeal, placeBid, redeal, shuffledDominoOrder, type Bid, type MatchState } from '@fortytwo/rules';

export function bidAndMaybeRedeal(match: MatchState, playerId: string, bid: Bid): MatchState {
  const next = placeBid(match, playerId, bid);
  return needsRedeal(next) ? redeal(next, shuffledDominoOrder()) : next;
}
```

In `matchDO.ts`, `import { bidAndMaybeRedeal } from './redeal';` and change `bid`:

```ts
    return this.update(playerId, (match) => bidAndMaybeRedeal(match, playerId, bid));
```

Remove `placeBid` from `matchDO.ts`'s rules import if it is now unused (typecheck will say).

In `apps/worker/src/bots.ts`, `import { bidAndMaybeRedeal } from './redeal';`, replace both bid cases:

```ts
    case 'bid':
      return bidAndMaybeRedeal(match, action.playerId, decideBid(match.currentGame, hand));
```
```ts
    case 'bid':
      return bidAndMaybeRedeal(match, action.playerId, bot.decideBid(match, action.playerId));
```

Then drop `placeBid` from that file's import. Also change the simple bot's `decideBid` comment from "The forced-bid rule ... only ever applies" to note that under the redeal house rule nobody is forced, so it passes.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm test -w @fortytwo/worker && npm run typecheck -w @fortytwo/worker`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): create custom matches with house rules, redeal on all pass"
```

---

### Task 6: Lobby rows carry the house rules

**Files:**
- Create: `apps/worker/migrations/0012_matches_rules.sql`
- Modify: `packages/api-types/src/index.ts` (`HouseRules`, `MatchSummary.rules`)
- Modify: `apps/worker/src/lobby.ts` (`MatchIndexRow`, `syncLobbyIndex`, `refreshMatchSummary`, `upsertMatchSummary`, the three `SELECT`s)
- Modify: `apps/worker/src/routes/matches.ts` (row → `MatchSummary`)
- Test: `apps/worker/test/lobby.test.ts`, `apps/worker/test/routes.matches.test.ts`

**Interfaces:**
- Consumes: `isDefaultHouseRules` from Task 1; `POST /api/matches` with rules from Task 5.
- Produces: `MatchSummary.rules?: HouseRules` (api-types repeats the rules package's type, as it does `MatchMode`). The D1 `matches.rules` is TEXT JSON, null for default rules.

- [ ] **Step 1: Write the failing tests**

Append to `apps/worker/test/lobby.test.ts` inside `describe('lobby', ...)`:

```ts
  describe('house rules', () => {
    it('stores a custom table\'s rules as JSON and lists them', async () => {
      await upsertMatchSummary(testEnv.DB, {
        id: 'm-rules', status: 'active', playerCount: 1, updatedOn: '2026-10-14T01:00:00Z', mode: 'custom',
        rules: JSON.stringify({ low: 'off', plunge: true, allPass: 'forceLast', marksToWin: 5 }),
      });
      await syncMatchPlayers(testEnv.DB, 'm-rules', seat('p1'));
      const [row] = (await listActive(testEnv.DB, 'p1')).rows;
      expect(JSON.parse(row.rules!)).toEqual({ low: 'off', plunge: true, allPass: 'forceLast', marksToWin: 5 });
    });

    it('keeps the rules when a later sync sends none', async () => {
      await upsertMatchSummary(testEnv.DB, { id: 'm-keep', status: 'active', playerCount: 1, updatedOn: '2026-10-14T01:00:00Z', rules: '{"marksToWin":5}' });
      await upsertMatchSummary(testEnv.DB, { id: 'm-keep', status: 'active', playerCount: 2, updatedOn: '2026-10-14T02:00:00Z' });
      const stored = await testEnv.DB.prepare('SELECT rules FROM matches WHERE id = ?').bind('m-keep').first<{ rules: string }>();
      expect(stored?.rules).toBe('{"marksToWin":5}');
    });
  });
```

(`seat` is the file's existing helper; check its signature and adjust if it takes positions.)

Append to `routes.matches.test.ts`'s `POST /api/matches house rules` block:

```ts
    it('lists the rules on the lobby row, and nothing for a default table', async () => {
      const p1 = await signToken('p1');
      const ruled = (await (await api('/api/matches', p1, { method: 'POST', body: JSON.stringify({ rules: { plunge: false } }) })).json()) as MatchState;
      const plain = (await (await api('/api/matches', p1, { method: 'POST' })).json()) as MatchState;

      const list = (await (await api('/api/matches?filter=Active', p1)).json()) as { matches: { id: string; rules?: unknown }[] };
      expect(list.matches.find((m) => m.id === ruled.id)?.rules).toEqual({ low: 'on', plunge: false, allPass: 'forceLast', marksToWin: 7 });
      expect(list.matches.find((m) => m.id === plain.id)).not.toHaveProperty('rules');
    });
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npm test -w @fortytwo/worker -- lobby.test routes.matches`
Expected: FAIL. There's no `rules` column, and the TypeScript test file won't typecheck the `rules` field (vitest still runs it; the failures are the D1 errors).

- [ ] **Step 3: Implement**

`apps/worker/migrations/0012_matches_rules.sql`:

```sql
-- A custom table's house rules as JSON (the rules package's HouseRules). Null for every other
-- table and for a custom table on the default rules. Written when the row is first written and
-- never changed after, so it costs no extra writes.
ALTER TABLE matches ADD COLUMN rules TEXT;
```

Check how the test pool applies migrations (`apps/worker/test/applyMigrations.ts`). If it lists the files explicitly instead of reading the folder, add `0012_matches_rules.sql` there.

`packages/api-types/src/index.ts`: add below `MatchMode`:

```ts
// A custom table's house rules (the rules package's HouseRules, repeated here since this package
// is types only). Only on rows whose rules differ from the defaults.
export interface HouseRules {
  low: 'off' | 'on' | 'forcedOnly';
  plunge: boolean;
  allPass: 'forceLast' | 'redeal';
  marksToWin: number;
}
```
and in `MatchSummary` after `mode`:
```ts
  rules?: HouseRules;
```

`apps/worker/src/lobby.ts`:

```ts
export type MatchIndexRow = Omit<MatchSummary, 'teams' | 'seats' | 'turn' | 'mode' | 'rules'> & {
  mode?: MatchMode | null;
  // HouseRules as JSON; null or absent for default rules.
  rules?: string | null;
};
```

Add `isDefaultHouseRules` to the `@fortytwo/rules` import, and a helper:

```ts
// The `rules` column for a match: its house rules as JSON, or null on the default rules.
function rulesColumn(match: MatchState): string | null {
  return isDefaultHouseRules(match.rules) ? null : JSON.stringify(match.rules);
}
```

- `syncLobbyIndex`: add `rules: rulesColumn(match),` to the upsert object.
- `refreshMatchSummary`: the `INSERT OR IGNORE` becomes `INSERT OR IGNORE INTO matches (id, status, player_count, updated_on, mode, rules) VALUES (?, ?, ?, ?, ?, ?)` bound with `rulesColumn(match)` last.
- `upsertMatchSummary`:
```ts
      `INSERT INTO matches (id, status, player_count, updated_on, mode, rules) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, player_count = excluded.player_count,
         updated_on = excluded.updated_on, mode = COALESCE(excluded.mode, matches.mode),
         rules = COALESCE(excluded.rules, matches.rules)`
    )
    .bind(summary.id, summary.status, summary.playerCount, summary.updatedOn, summary.mode ?? null, summary.rules ?? null)
```
- `listForPlayer`'s `SELECT`: add `, m.rules`. `listJoinable`'s `SELECT`: add `, rules`. If any other `SELECT ... AS updatedOn` in `lobby.ts` feeds `MatchIndexRow`, add it there too (`grep -n "AS updatedOn" apps/worker/src/lobby.ts`).

`apps/worker/src/routes/matches.ts`, in the `rows.map((row): MatchSummary => ...)`: add `type HouseRules` to the api-types import and change the return to:

```ts
    const { rules, ...rest } = row;
    return {
      ...rest,
      mode: row.mode ?? 'custom',
      ...(rules ? { rules: JSON.parse(rules) as HouseRules } : {}),
      teams: [namesOn(Teams.TeamA), namesOn(Teams.TeamB)],
      seats,
      ...(turns ? { turn: turns.get(row.id) ?? null } : {}),
    };
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm test -w @fortytwo/worker && npm run typecheck --workspaces --if-present`
Expected: all PASS. The full typecheck covers api-types' consumers.

- [ ] **Step 5: Commit**

```bash
git add apps/worker packages/api-types
git commit -m "feat(worker): lobby rows carry a custom table's house rules"
```

---

### Task 7: Client: create with rules, labels, and marks to win

**Files:**
- Create: `packages/client/src/houseRules.ts`
- Create: `packages/client/src/houseRules.test.ts`
- Modify: `packages/client/src/api.ts` (`createMatch`)
- Modify: `packages/client/src/lobby.ts` (new `rowLabel`)
- Modify: `packages/client/src/matchView.ts` (remove `MARKS_TO_WIN`)
- Modify: `packages/client/src/index.ts`
- Test: `packages/client/src/api.test.ts`, `packages/client/src/lobby.test.ts`

**Interfaces:**
- Consumes: `HouseRules`, `DEFAULT_HOUSE_RULES`, `houseRules`, `MIN_MARKS_TO_WIN`, `MAX_MARKS_TO_WIN` from `@fortytwo/rules`.
- Produces:
  - `houseRuleLabels(rules: Partial<HouseRules> | undefined): string[]`
  - `setHouseRule(rules: HouseRules, patch: Partial<HouseRules>): HouseRules`: applies the patch, then moves `low` from `forcedOnly` to `on` when `allPass` is `redeal`, and clamps `marksToWin` to 1..21.
  - `marksToWin(match: { rules?: Partial<HouseRules> }): number`
  - `rowLabel(match: MatchSummary): string`: `MODE_LABELS[mode]` followed by the rule labels, joined with ` · `.
  - `createMatch(rules?: HouseRules): Promise<MatchState>`
  - `MARKS_TO_WIN` is **removed** (Tasks 8 and 9 replace its two uses).

- [ ] **Step 1: Write the failing tests**

`packages/client/src/houseRules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_HOUSE_RULES } from '@fortytwo/rules';
import { houseRuleLabels, marksToWin, setHouseRule } from './houseRules';

describe('houseRuleLabels', () => {
  it('says nothing about default rules', () => {
    expect(houseRuleLabels(undefined)).toEqual([]);
    expect(houseRuleLabels(DEFAULT_HOUSE_RULES)).toEqual([]);
  });

  it('names each setting that differs, in a fixed order', () => {
    expect(houseRuleLabels({ low: 'off', plunge: false, allPass: 'redeal', marksToWin: 5 })).toEqual([
      'No Low', 'No Plunge', 'Redeal on all pass', 'To 5 marks',
    ]);
    expect(houseRuleLabels({ low: 'forcedOnly' })).toEqual(['Low only when forced']);
    expect(houseRuleLabels({ marksToWin: 1 })).toEqual(['To 1 mark']);
  });
});

describe('setHouseRule', () => {
  it('moves forcedOnly Low to on when redeal is picked', () => {
    const rules = { ...DEFAULT_HOUSE_RULES, low: 'forcedOnly' as const };
    expect(setHouseRule(rules, { allPass: 'redeal' })).toEqual({ ...DEFAULT_HOUSE_RULES, allPass: 'redeal' });
  });

  it('keeps marks to win from 1 to 21', () => {
    expect(setHouseRule(DEFAULT_HOUSE_RULES, { marksToWin: 0 }).marksToWin).toBe(1);
    expect(setHouseRule(DEFAULT_HOUSE_RULES, { marksToWin: 22 }).marksToWin).toBe(21);
  });
});

describe('marksToWin', () => {
  it('is 7 without rules, or the house number', () => {
    expect(marksToWin({})).toBe(7);
    expect(marksToWin({ rules: { ...DEFAULT_HOUSE_RULES, marksToWin: 11 } })).toBe(11);
  });
});
```

In `packages/client/src/lobby.test.ts`, add (merging the import of `rowLabel`):

```ts
describe('rowLabel', () => {
  it('is the mode, then any house rules', () => {
    const base = { id: 'm', status: 'active', playerCount: 4, updatedOn: '', teams: [[], []], seats: [], mode: 'custom' } as const;
    expect(rowLabel({ ...base })).toBe('Custom');
    expect(rowLabel({ ...base, rules: { low: 'forcedOnly', plunge: true, allPass: 'forceLast', marksToWin: 5 } })).toBe(
      'Custom · Low only when forced · To 5 marks'
    );
  });
});
```

In `packages/client/src/api.test.ts`, add next to the existing `createMatch` tests:

```ts
  it('sends house rules when creating a custom match, and no body without them', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: 'm1' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchSpy);
    const api = createApiClient(async () => 'token', '');
    const rules = { low: 'off', plunge: true, allPass: 'forceLast', marksToWin: 7 } as const;

    await api.createMatch(rules);
    await api.createMatch();

    expect(JSON.parse(fetchSpy.mock.calls[0][1].body as string)).toEqual({ rules });
    expect(fetchSpy.mock.calls[1][1].body).toBeUndefined();
  });
```

Type the `fetchSpy` calls the way the surrounding tests do if TypeScript complains about the tuple access (for example `(fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1]`).

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npm test -w @fortytwo/client`
Expected: FAIL. `./houseRules` and `rowLabel` don't exist, and `createMatch` sends no body.

- [ ] **Step 3: Implement**

`packages/client/src/houseRules.ts`:

```ts
// House rules as both apps show and edit them: the short labels for the lobby row and the match
// screen, and the create form's one consistency rule. The rules themselves are @fortytwo/rules'.
import {
  DEFAULT_HOUSE_RULES,
  MAX_MARKS_TO_WIN,
  MIN_MARKS_TO_WIN,
  houseRules,
  type HouseRules,
} from '@fortytwo/rules';

// One label per setting that differs from the defaults, so a standard table shows nothing.
export function houseRuleLabels(rules: Partial<HouseRules> | undefined): string[] {
  const r = houseRules({ rules });
  const labels: string[] = [];
  if (r.low === 'off') labels.push('No Low');
  if (r.low === 'forcedOnly') labels.push('Low only when forced');
  if (!r.plunge) labels.push('No Plunge');
  if (r.allPass === 'redeal') labels.push('Redeal on all pass');
  if (r.marksToWin !== DEFAULT_HOUSE_RULES.marksToWin) labels.push(`To ${r.marksToWin} ${r.marksToWin === 1 ? 'mark' : 'marks'}`);
  return labels;
}

// The create form's change to one setting. Nobody is forced under redeal, so Low-only-when-forced
// becomes plain Low; marks to win stays in range.
export function setHouseRule(rules: HouseRules, patch: Partial<HouseRules>): HouseRules {
  const next = { ...rules, ...patch };
  if (next.allPass === 'redeal' && next.low === 'forcedOnly') next.low = 'on';
  next.marksToWin = Math.min(MAX_MARKS_TO_WIN, Math.max(MIN_MARKS_TO_WIN, Math.round(next.marksToWin)));
  return next;
}

export function marksToWin(match: { rules?: Partial<HouseRules> }): number {
  return houseRules(match).marksToWin;
}
```

`packages/client/src/lobby.ts`: import `houseRuleLabels` from `./houseRules` and add after `MODE_LABELS`:

```ts
// The row's "how this match is played" text: its mode, then any house rules.
export function rowLabel(match: MatchSummary): string {
  return [MODE_LABELS[match.mode], ...houseRuleLabels(match.rules)].join(' · ');
}
```

`packages/client/src/api.ts`: add `type HouseRules` to the `@fortytwo/rules` import (or wherever `MatchState` comes from) and change:

```ts
    // A custom table, on the given house rules or the defaults.
    createMatch: (rules?: HouseRules): Promise<MatchState> =>
      request<MatchState>('/api/matches', { method: 'POST', ...(rules ? { body: JSON.stringify({ rules }) } : {}) }),
```

`packages/client/src/matchView.ts`: delete the `MARKS_TO_WIN` constant and its comment.

`packages/client/src/index.ts`: add `export * from './houseRules';`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm test -w @fortytwo/client && npm run typecheck -w @fortytwo/client`
Expected: PASS. (The web and mobile typechecks will fail on `MARKS_TO_WIN` until Tasks 8 and 9, which is expected.)

- [ ] **Step 5: Commit**

```bash
git add packages/client
git commit -m "feat(client): house rule labels, create with rules, marks to win per match"
```

---

### Task 8: Web: House rules step, lobby row, match screen

**Files:**
- Create: `apps/web/src/components/HouseRulesForm.tsx`
- Create: `apps/web/src/components/HouseRulesForm.test.tsx`
- Modify: `apps/web/src/components/NewMatchDialog.tsx` (+ `.css`)
- Modify: `apps/web/src/components/NewMatchDialog.test.tsx`
- Modify: `apps/web/src/pages/Lobby.tsx`
- Modify: `apps/web/src/pages/Match.tsx` (+ its CSS)
- Test: `apps/web/src/pages/Match.test.tsx`

**Interfaces:**
- Consumes: `DEFAULT_HOUSE_RULES`, `MIN_MARKS_TO_WIN`, `MAX_MARKS_TO_WIN`, `type HouseRules` (`@fortytwo/rules`); `setHouseRule`, `houseRuleLabels`, `marksToWin`, `rowLabel`, `createMatch(rules?)` (`@fortytwo/client`).
- Produces: `NewMatchDialog`'s `onChoose: (choice: NewMatchChoice, rules?: HouseRules) => void`. `HouseRulesForm({ rules, onChange, disabled })`.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/components/HouseRulesForm.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HOUSE_RULES } from '@fortytwo/rules';
import { HouseRulesForm } from './HouseRulesForm';

afterEach(cleanup);

describe('HouseRulesForm', () => {
  it('shows the defaults selected', () => {
    render(<HouseRulesForm rules={DEFAULT_HOUSE_RULES} onChange={vi.fn()} />);
    expect((screen.getByRole('radio', { name: 'On' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /plunge/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /last player must bid/i }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('reports each change', () => {
    const onChange = vi.fn();
    render(<HouseRulesForm rules={DEFAULT_HOUSE_RULES} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /plunge/i }));
    fireEvent.click(screen.getByRole('button', { name: /more marks/i }));
    expect(onChange.mock.calls).toEqual([
      [{ ...DEFAULT_HOUSE_RULES, low: 'off' }],
      [{ ...DEFAULT_HOUSE_RULES, plunge: false }],
      [{ ...DEFAULT_HOUSE_RULES, marksToWin: 8 }],
    ]);
  });

  it('moves Low only when forced to On when Redeal is picked, and disables it', () => {
    const onChange = vi.fn();
    const { rerender } = render(<HouseRulesForm rules={{ ...DEFAULT_HOUSE_RULES, low: 'forcedOnly' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: /redeal/i }));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_HOUSE_RULES, allPass: 'redeal' });

    rerender(<HouseRulesForm rules={{ ...DEFAULT_HOUSE_RULES, allPass: 'redeal' }} onChange={onChange} />);
    expect((screen.getByRole('radio', { name: /only when forced/i }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/nobody is forced to bid/i)).toBeTruthy();
  });

  it('stops the marks stepper at 1 and 21', () => {
    const { rerender } = render(<HouseRulesForm rules={{ ...DEFAULT_HOUSE_RULES, marksToWin: 1 }} onChange={vi.fn()} />);
    expect((screen.getByRole('button', { name: /fewer marks/i }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<HouseRulesForm rules={{ ...DEFAULT_HOUSE_RULES, marksToWin: 21 }} onChange={vi.fn()} />);
    expect((screen.getByRole('button', { name: /more marks/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

In `NewMatchDialog.test.tsx`, change the first test's expectation (Custom Match no longer reports straight away) and add:

```tsx
  it('offers Live Play and Async straight away, and Custom Match after its house rules', () => {
    const onChoose = vi.fn();
    render(<NewMatchDialog open liveEnabled online={null} pending={null} error={null} onChoose={onChoose} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /live play/i }));
    fireEvent.click(screen.getByRole('button', { name: /async/i }));
    fireEvent.click(screen.getByRole('button', { name: /custom match/i }));
    expect(onChoose.mock.calls).toEqual([['live'], ['daily']]);
    expect(screen.getByRole('heading', { name: /house rules/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    fireEvent.click(screen.getByRole('button', { name: /create table/i }));
    expect(onChoose).toHaveBeenLastCalledWith('challenge', { ...DEFAULT_HOUSE_RULES, low: 'off' });
  });

  it('goes back from the house rules to the choices', () => {
    render(<NewMatchDialog open liveEnabled online={null} pending={null} error={null} onChoose={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /custom match/i }));
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByRole('button', { name: /async/i })).toBeTruthy();
  });

  it('shows the custom table being set up on Create table', () => {
    render(<NewMatchDialog open liveEnabled online={null} pending="challenge" error={null} onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /setting up the table/i })).toBeTruthy();
  });
```

Remove `['challenge']` from the existing first test's expected calls (or delete that test, since the new one covers it). Import `DEFAULT_HOUSE_RULES` from `@fortytwo/rules`.

In `apps/web/src/pages/Match.test.tsx` (it has `baseMatch(overrides, gameOverrides)`, `renderMatch()` and `useMatchSocketMock`), add:

```tsx
  describe('house rules', () => {
    const rules = { low: 'off', plunge: true, allPass: 'forceLast', marksToWin: 5 } as const;

    it('shows the house rules under the score, and a tally as long as marks to win', () => {
      useMatchSocketMock.mockReturnValue({ match: baseMatch({ rules }), connected: true });
      const { container } = renderMatch();
      expect(screen.getByText('House rules: No Low · To 5 marks')).toBeTruthy();
      expect(container.querySelectorAll('.score-us .mark')).toHaveLength(5);
    });

    it('shows no house rules line on default rules', () => {
      useMatchSocketMock.mockReturnValue({ match: baseMatch(), connected: true });
      const { container } = renderMatch();
      expect(screen.queryByText(/house rules:/i)).toBeNull();
      expect(container.querySelectorAll('.score-us .mark')).toHaveLength(7);
    });

    it('says the hands were redealt while bidding a redealt hand', () => {
      useMatchSocketMock.mockReturnValue({ match: baseMatch({}, { redealt: true }), connected: true });
      renderMatch();
      expect(screen.getByText('Everyone passed, so the hands were dealt again.')).toBeTruthy();
    });
  });
```

If the existing tests pass more fields to `useMatchSocketMock.mockReturnValue` (for example `reconnecting`), copy them.

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npm test -w @fortytwo/web -- HouseRulesForm NewMatchDialog Match.test`
Expected: FAIL. There's no form yet, Custom Match reports immediately, and there's no rules line.

- [ ] **Step 3: Implement**

`apps/web/src/components/HouseRulesForm.tsx`:

```tsx
// The house rules a Custom Match's creator picks (NewMatchDialog's second step). Controlled:
// every change goes through setHouseRule, which keeps the combination valid.
import type { JSX } from 'react';
import { MAX_MARKS_TO_WIN, MIN_MARKS_TO_WIN, type HouseRules, type LowRule } from '@fortytwo/rules';
import { setHouseRule } from '@fortytwo/client';

const LOW_OPTIONS: { value: LowRule; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
  { value: 'forcedOnly', label: 'Only when forced' },
];

export function HouseRulesForm({
  rules,
  onChange,
  disabled = false,
}: {
  rules: HouseRules;
  onChange: (rules: HouseRules) => void;
  disabled?: boolean;
}): JSX.Element {
  const change = (patch: Partial<HouseRules>) => onChange(setHouseRule(rules, patch));
  const redeal = rules.allPass === 'redeal';

  return (
    <div className="house-rules">
      <fieldset className="house-rules-field" disabled={disabled}>
        <legend>Low</legend>
        {LOW_OPTIONS.map((o) => (
          <label key={o.value} className="house-rules-choice">
            <input
              type="radio"
              name="low"
              checked={rules.low === o.value}
              disabled={o.value === 'forcedOnly' && redeal}
              onChange={() => change({ low: o.value })}
            />
            {o.label}
          </label>
        ))}
        {redeal && <p className="house-rules-note">Nobody is forced to bid when everyone passing redeals.</p>}
      </fieldset>

      <fieldset className="house-rules-field" disabled={disabled}>
        <legend>Plunge</legend>
        <label className="house-rules-choice">
          <input type="checkbox" checked={rules.plunge} onChange={(e) => change({ plunge: e.target.checked })} />
          Allow Plunge
        </label>
      </fieldset>

      <fieldset className="house-rules-field" disabled={disabled}>
        <legend>When everyone passes</legend>
        <label className="house-rules-choice">
          <input type="radio" name="allPass" checked={!redeal} onChange={() => change({ allPass: 'forceLast' })} />
          Last player must bid
        </label>
        <label className="house-rules-choice">
          <input type="radio" name="allPass" checked={redeal} onChange={() => change({ allPass: 'redeal' })} />
          Redeal
        </label>
      </fieldset>

      <fieldset className="house-rules-field" disabled={disabled}>
        <legend>Marks to win</legend>
        <div className="house-rules-stepper">
          <button
            type="button"
            aria-label="Fewer marks"
            disabled={rules.marksToWin <= MIN_MARKS_TO_WIN}
            onClick={() => change({ marksToWin: rules.marksToWin - 1 })}
          >
            −
          </button>
          <span aria-live="polite">{rules.marksToWin}</span>
          <button
            type="button"
            aria-label="More marks"
            disabled={rules.marksToWin >= MAX_MARKS_TO_WIN}
            onClick={() => change({ marksToWin: rules.marksToWin + 1 })}
          >
            +
          </button>
        </div>
      </fieldset>
    </div>
  );
}
```

`apps/web/src/components/NewMatchDialog.tsx`:

- Import `useState` (already), `DEFAULT_HOUSE_RULES` and `type HouseRules` from `@fortytwo/rules`, and `HouseRulesForm`.
- Change the prop to `onChoose: (choice: NewMatchChoice, rules?: HouseRules) => void;` and update the file's top comment: "Custom Match first asks for its house rules".
- Add state, reset whenever the dialog opens:
```tsx
  const [step, setStep] = useState<'choose' | 'rules'>('choose');
  const [rules, setRules] = useState<HouseRules>(DEFAULT_HOUSE_RULES);
  useEffect(() => {
    if (open) {
      setStep('choose');
      setRules(DEFAULT_HOUSE_RULES);
    }
  }, [open]);
```
  Put this before the `if (!open) return null;` (hooks can't come after an early return).
- The option button's `onClick` becomes `onClick={() => (o.choice === 'challenge' ? setStep('rules') : onChoose(o.choice))}`.
- When `step === 'rules'`, render instead of the `GROUPS.map(...)`:
```tsx
        {step === 'rules' ? (
          <section className="new-match-rules" aria-labelledby="new-match-rules-title">
            <h3 id="new-match-rules-title" className="new-match-group-label">House rules</h3>
            <HouseRulesForm rules={rules} onChange={setRules} disabled={pending !== null} />
            <div className="new-match-rules-actions">
              <button type="button" className="new-match-back" disabled={pending !== null} onClick={() => setStep('choose')}>
                Back
              </button>
              <button
                type="button"
                className={`new-match-create${pending === 'challenge' ? ' is-working' : ''}`}
                disabled={pending !== null}
                aria-busy={pending === 'challenge'}
                onClick={() => onChoose('challenge', rules)}
              >
                {pending === 'challenge' ? workingDetail('challenge', slow) : 'Create table'}
              </button>
            </div>
          </section>
        ) : (
          GROUPS.map(/* unchanged */)
        )}
```
- Add CSS to `NewMatchDialog.css` for `.house-rules`, `.house-rules-field` (no border, small legend in the group-label style), `.house-rules-choice` (inline-flex, gap), `.house-rules-note` (muted, small), `.house-rules-stepper` (inline-flex, centred number, square buttons), and `.new-match-rules-actions` (flex, space-between, top margin). Use the colour tokens the file already uses, not new values.

`apps/web/src/pages/Lobby.tsx`:

```tsx
  const startMatch = useMutation({
    mutationFn: ({ choice, rules }: { choice: NewMatchChoice; rules?: HouseRules }) =>
      choice === 'challenge' ? client.createMatch(rules) : choice === 'bots' ? client.playBots() : client.play(choice),
```
```tsx
        pending={startMatch.isPending ? startMatch.variables.choice : null}
        ...
        onChoose={(choice, rules) => startMatch.mutate({ choice, rules })}
```
and in the row, replace `MODE_LABELS[match.mode]` (both places on that line) with `rowLabel(match)`, importing `rowLabel` from `@fortytwo/client` (drop `MODE_LABELS` from the import if unused).

`apps/web/src/pages/Match.tsx`:

- Replace the `MARKS_TO_WIN` import with `marksToWin, houseRuleLabels`.
- `MarkTally` takes the total:
```tsx
// `total` marks win the match (marksToWin: 7 unless the house rules say otherwise) - drawn as a tally.
function MarkTally({ marks, total }: { marks: number; total: number }): JSX.Element {
  return (
    <span className="mark-tally" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
```
- At both `<MarkTally ... />` calls add `total={marksToWin(match)}` (use whatever the component calls the current `MatchState` there).
- Directly after `</header>` (the scoreboard), add:
```tsx
      {houseRuleLabels(match.rules).length > 0 && (
        <p className="house-rules-line">House rules: {houseRuleLabels(match.rules).join(' · ')}</p>
      )}
      {match.currentGame.redealt && isBiddingPhase && (
        <p className="redeal-line" role="status">Everyone passed, so the hands were dealt again.</p>
      )}
```
  using the component's existing bidding-phase flag from `describeMatch` (`view.isBiddingPhase` or however it is destructured).
- In Match's CSS, add `flex-wrap: wrap;` to `.mark-tally`, plus small muted centred text styles for `.house-rules-line` and `.redeal-line`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm test -w @fortytwo/web && npm run typecheck -w @fortytwo/web && npm run lint -w @fortytwo/web`
Expected: all PASS.

- [ ] **Step 5: Look at it**

Use the `run` skill to start the web app against a local worker. Create a Custom Match with Low "Only when forced" and 5 marks, and check the dialog step, the lobby row and the match screen. Then do the same with 21 marks to check the tally wraps.

- [ ] **Step 6: Commit**

```bash
git add apps/web
git commit -m "feat(web): pick house rules for a Custom Match and show them"
```

---

### Task 9: Mobile: House rules step, lobby row, match screen

**Files:**
- Create: `apps/mobile/src/components/HouseRulesForm.tsx`
- Modify: `apps/mobile/src/components/NewMatchSheet.tsx`
- Modify: `apps/mobile/src/app/index.tsx`
- Modify: `apps/mobile/src/app/match/[id].tsx`
- Test: `apps/mobile/src/components/__tests__/components.test.tsx`, `apps/mobile/src/match/__tests__/matchScreen.test.tsx`

**Interfaces:**
- Consumes: the same as Task 8.
- Produces: `NewMatchSheet`'s `onChoose: (choice: NewMatchChoice, rules?: HouseRules) => void`. `HouseRulesForm({ rules, onChange, disabled })` (React Native).

- [ ] **Step 1: Write the failing tests**

In `components.test.tsx`, change the first `NewMatchSheet` test's expected calls to `[['live'], ['daily']]` and add:

```tsx
  it('asks for house rules before creating a Custom Match', async () => {
    const onChoose = jest.fn();
    await render(inApp(<NewMatchSheet visible liveEnabled online={null} pending={null} error={null} onChoose={onChoose} onClose={jest.fn()} />));
    await fireEvent.press(screen.getByRole('button', { name: /custom match/i }));
    expect(onChoose).not.toHaveBeenCalled();
    expect(screen.getByText('House rules')).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: 'Off' }));
    await fireEvent.press(screen.getByRole('button', { name: /more marks/i }));
    await fireEvent.press(screen.getByRole('button', { name: /create table/i }));
    expect(onChoose).toHaveBeenLastCalledWith('challenge', { ...DEFAULT_HOUSE_RULES, low: 'off', marksToWin: 8 });
  });

  it('disables Low only when forced while Redeal is picked', async () => {
    await render(inApp(<NewMatchSheet visible liveEnabled online={null} pending={null} error={null} onChoose={jest.fn()} onClose={jest.fn()} />));
    await fireEvent.press(screen.getByRole('button', { name: /custom match/i }));
    await fireEvent.press(screen.getByRole('radio', { name: /redeal/i }));
    expect(screen.getByRole('radio', { name: /only when forced/i }).props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('goes back from the house rules to the choices', async () => {
    await render(inApp(<NewMatchSheet visible liveEnabled online={null} pending={null} error={null} onChoose={jest.fn()} onClose={jest.fn()} />));
    await fireEvent.press(screen.getByRole('button', { name: /custom match/i }));
    await fireEvent.press(screen.getByRole('button', { name: /back/i }));
    expect(screen.getByRole('button', { name: /async/i })).toBeTruthy();
  });
```

Import `DEFAULT_HOUSE_RULES` from `@fortytwo/rules`. If `getByRole('radio')` doesn't find a `Pressable` with `accessibilityRole="radio"` in this RNTL version, query with `getByLabelText` instead.

In `apps/mobile/src/match/__tests__/matchScreen.test.tsx` (it has `dealtLiveWithBots(overrides)`, `socket(match)` and `renderScreen()`), add:

```tsx
describe('Match screen, house rules', () => {
  const rules = { low: 'off', plunge: true, allPass: 'forceLast', marksToWin: 5 } as const;

  it('shows the house rules and scores out of marks to win', async () => {
    socket(dealtLiveWithBots({ mode: 'custom', rules }));
    await renderScreen();
    expect(await screen.findByText('House rules: No Low · To 5 marks')).toBeTruthy();
    expect(screen.getByLabelText('Us: 0 of 5 marks')).toBeTruthy();
  });

  it('says the hands were redealt while bidding a redealt hand', async () => {
    const match = dealtLiveWithBots({ mode: 'custom', rules: { ...rules, allPass: 'redeal' } });
    socket({ ...match, currentGame: { ...match.currentGame, redealt: true } });
    await renderScreen();
    expect(await screen.findByText('Everyone passed, so the hands were dealt again.')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `npm test -w @fortytwo/mobile -- components matchScreen`
Expected: FAIL.

- [ ] **Step 3: Implement**

`apps/mobile/src/components/HouseRulesForm.tsx`. Same behaviour as the web form, with React Native controls styled like `NewMatchSheet` (import `colors, fonts` from `@/components/theme`):

```tsx
// The house rules a Custom Match's creator picks (NewMatchSheet's second step). Controlled: every
// change goes through setHouseRule, which keeps the combination valid.
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { MAX_MARKS_TO_WIN, MIN_MARKS_TO_WIN, type AllPassRule, type HouseRules, type LowRule } from '@fortytwo/rules';
import { setHouseRule } from '@fortytwo/client';
import { colors, fonts } from '@/components/theme';

const LOW_OPTIONS: { value: LowRule; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
  { value: 'forcedOnly', label: 'Only when forced' },
];
const ALL_PASS_OPTIONS: { value: AllPassRule; label: string }[] = [
  { value: 'forceLast', label: 'Last player must bid' },
  { value: 'redeal', label: 'Redeal' },
];

function Segment<T extends string>({ options, value, onPick, isDisabled, disabled }: {
  options: { value: T; label: string }[];
  value: T;
  onPick: (value: T) => void;
  isDisabled?: (value: T) => boolean;
  disabled: boolean;
}) {
  return (
    <View style={styles.segment}>
      {options.map((o) => {
        const off = disabled || (isDisabled?.(o.value) ?? false);
        const selected = value === o.value;
        return (
          <Pressable
            key={o.value}
            style={[styles.segmentItem, selected && styles.segmentSelected, off && styles.dim]}
            disabled={off}
            onPress={() => onPick(o.value)}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityState={{ selected, disabled: off }}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function HouseRulesForm({ rules, onChange, disabled = false }: {
  rules: HouseRules;
  onChange: (rules: HouseRules) => void;
  disabled?: boolean;
}) {
  const change = (patch: Partial<HouseRules>) => onChange(setHouseRule(rules, patch));
  const redeal = rules.allPass === 'redeal';
  return (
    <View style={styles.form}>
      <Text style={styles.label}>Low</Text>
      <Segment options={LOW_OPTIONS} value={rules.low} onPick={(low) => change({ low })}
        isDisabled={(v) => v === 'forcedOnly' && redeal} disabled={disabled} />
      {redeal && <Text style={styles.note}>Nobody is forced to bid when everyone passing redeals.</Text>}

      <View style={styles.row}>
        <Text style={styles.label}>Allow Plunge</Text>
        <Switch value={rules.plunge} onValueChange={(plunge) => change({ plunge })} disabled={disabled}
          accessibilityLabel="Allow Plunge" />
      </View>

      <Text style={styles.label}>When everyone passes</Text>
      <Segment options={ALL_PASS_OPTIONS} value={rules.allPass} onPick={(allPass) => change({ allPass })} disabled={disabled} />

      <View style={styles.row}>
        <Text style={styles.label}>Marks to win</Text>
        <View style={styles.stepper}>
          <Pressable style={[styles.step, (disabled || rules.marksToWin <= MIN_MARKS_TO_WIN) && styles.dim]}
            disabled={disabled || rules.marksToWin <= MIN_MARKS_TO_WIN}
            onPress={() => change({ marksToWin: rules.marksToWin - 1 })}
            accessibilityRole="button" accessibilityLabel="Fewer marks">
            <Text style={styles.stepText}>−</Text>
          </Pressable>
          <Text style={styles.marks}>{rules.marksToWin}</Text>
          <Pressable style={[styles.step, (disabled || rules.marksToWin >= MAX_MARKS_TO_WIN) && styles.dim]}
            disabled={disabled || rules.marksToWin >= MAX_MARKS_TO_WIN}
            onPress={() => change({ marksToWin: rules.marksToWin + 1 })}
            accessibilityRole="button" accessibilityLabel="More marks">
            <Text style={styles.stepText}>+</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 10 },
  label: { color: colors.inkMuted, fontFamily: fonts.uiBold, fontSize: 12, letterSpacing: 1 },
  note: { color: colors.inkMuted, fontFamily: fonts.ui, fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  segment: { flexDirection: 'row', borderRadius: 14, backgroundColor: colors.mat, padding: 4, gap: 4 },
  segmentItem: { flex: 1, paddingVertical: 10, paddingHorizontal: 6, borderRadius: 10, alignItems: 'center' },
  segmentSelected: { backgroundColor: colors.brass },
  segmentText: { color: colors.bone, fontFamily: fonts.uiMedium, fontSize: 14, textAlign: 'center' },
  segmentTextSelected: { color: colors.walnutDeep, fontFamily: fonts.uiBold },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  step: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.brass, alignItems: 'center', justifyContent: 'center' },
  stepText: { color: colors.walnutDeep, fontFamily: fonts.uiBold, fontSize: 18 },
  marks: { minWidth: 28, textAlign: 'center', color: colors.bone, fontFamily: fonts.uiBold, fontSize: 18 },
  dim: { opacity: 0.6 },
});
```

These reuse `NewMatchSheet`'s colours and fonts (`colors.mat`, `colors.brass`, `colors.bone`, `colors.walnutDeep`, `colors.inkMuted`, `fonts.ui*`).

`apps/mobile/src/components/NewMatchSheet.tsx`: make the same changes as on web. Add the `onChoose` signature, `step`/`rules` state reset on `visible`, and send Custom Match to the rules step. When `step === 'rules'`, render a "House rules" header `Text` (`accessibilityRole="header"`), the `HouseRulesForm`, and a row with a **Back** `Pressable` and a **Create table** `Pressable`. Create table shows an `ActivityIndicator` and `workingDetail('challenge', slow)` while `pending === 'challenge'`, and calls `onChoose('challenge', rules)`. Both have `accessibilityRole="button"` and accessibility labels "Back" and "Create table" (or the working text while pending). Update the file's top comment.

`apps/mobile/src/app/index.tsx`: change the mutation to take `{ choice, rules }`, set `pending={start.isPending ? start.variables.choice : null}` and `onChoose={(choice, rules) => start.mutate({ choice, rules })}`. In the row, replace `{MODE_LABELS[match.mode]} · {status.text}` with `{rowLabel(match)} · {status.text}`.

`apps/mobile/src/app/match/[id].tsx`:
- Replace the `MARKS_TO_WIN` import with `marksToWin, houseRuleLabels`.
- `Score` takes `total: number` and uses it for the notch count and the label `${label}: ${marks} of ${total} marks`. Pass `total={marksToWin(match)}` at both call sites.
- Add `flexWrap: 'wrap'` to `styles.tally`, and a `maxWidth` that keeps the score column the same width it has today. Read the current `notch` size and margin: seven notches' width is the cap.
- After the scoreboard `View`, add:
```tsx
        {houseRuleLabels(match.rules).length > 0 && (
          <Text style={styles.houseRules}>House rules: {houseRuleLabels(match.rules).join(' · ')}</Text>
        )}
        {match.currentGame.redealt && isBiddingPhase && (
          <Text style={styles.redeal} accessibilityRole="alert">Everyone passed, so the hands were dealt again.</Text>
        )}
```
  using the screen's existing bidding-phase flag. Style both like the existing `reconnecting` text (small, muted, centred).

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `npm test -w @fortytwo/mobile && npm run typecheck -w @fortytwo/mobile`
Expected: all PASS. Don't run `expo lint`: it rewrites the lockfile (memory note).

- [ ] **Step 5: Look at it on the emulator**

Use the `mobile-emulator` skill. Open New match → Custom Match. Screenshot the House rules step, then create a table with "Only when forced", "No Plunge" and 21 marks. Screenshot the lobby row and the match screen. The 21-notch tally must wrap inside the score column, without pushing the contract text or overflowing the screen.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): pick house rules for a Custom Match and show them"
```

---

### Task 10: Whole-repo check and PR

- [ ] **Step 1: Run everything**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all PASS. Fix anything here before moving on. Pay particular attention to any leftover `MARKS_TO_WIN` or `WINNING_SCORE` reference that should now read the match's rules: `grep -rn "MARKS_TO_WIN\|WINNING_SCORE" --include=*.ts --include=*.tsx apps packages | grep -v node_modules`. The only expected `WINNING_SCORE` uses are its definition, its export, and `packages/client/src/howToPlay.ts` (the generic guide stays at the default).

- [ ] **Step 2: Open the PR**

Use superpowers:finishing-a-development-branch. The PR title is `feat: house rules for custom matches`. The body closes #117, lists the four rules, notes that migration `0012_matches_rules.sql` must be applied on deploy, and notes that the `ml-hints` worktree must pass `lowAllowedIfWon` to `optionsFromTable`.
