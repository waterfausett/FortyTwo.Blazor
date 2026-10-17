# Live Play searching screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Live Play search shown in the middle of the table with a matchmaking lobby below the table — progress bar toward the bot fill, a roster of four, and a swipeable tips/stats card — on mobile and web.

**Architecture:** The pure parts (roster order, bar progress, the card pages and the tip copy) live once in `@fortytwo/client` (`packages/client/src/searchLobby.ts`). Each app gets its own `SearchLobby` component, a small card carousel and a `useLobbyHold` hook that keeps the lobby up briefly after the table fills. The match screens show the lobby in place of the status line and hand while a Live search runs, and leave the mat empty.

**Tech Stack:** TypeScript; Expo 57 / React Native, Jest + @testing-library/react-native (mobile); React + Vite, Vitest + @testing-library/react, Bootstrap classes (web); Vitest (packages/client).

**Spec:** `docs/superpowers/specs/2026-10-16-live-search-screen-design.md`. Mockup: `docs/superpowers/specs/2026-10-16-live-search-screen-mockup.html`.

## Global Constraints

- The lobby replaces the in-mat Live UI only. Daily and Custom waiting stay as they are (their text and buttons stay in the mat).
- The bar fills from 0 to `LIVE_FILL_MS` and reads `${formatClock(remaining)} 🤖`. Only with `config.bots`. Without bots: no bar.
- The online count only when `useOnline()` is not null, shown as `${n} online` with a blinking green dot.
- Roster: four rows, the viewer first, then the other seats in seat order. Names only, no join times. Empty row text: `Searching…`. The viewer's row reads `You`.
- The card heading is `Did you know` for tips and `Your stats` for stats. It moves on every `LOBBY_CARD_MS = 9000` ms, pauses while touched or hovered, and stays still for `LOBBY_CARD_MS` after a manual swipe.
- Stats: the `all` summary, using the profile's labels and formatting (`statSections`, `trumpLabel`, `favoriteTrumpRecord`, `bestPartnerRecord`). With no stats (not loaded, failed, or `played === 0`): tips only.
- The button reads `Start with bots` on both apps. Cancel keeps each app's current text (`Cancel` mobile, `Cancel search` web) and behaviour.
- Table full: hold the lobby `LOBBY_FULL_HOLD_MS = 1200` ms with the bar replaced by `Table full`, client-side only, and only if this screen saw the search running.
- Reduced motion: no seat pulse, no dot blink, no automatic paging (swiping still works).
- A polite announcement when a player joins: `${name} joined, ${n} of 4` (`A player joined, ${n} of 4` while the name loads). No timer announcements, and the card's automatic paging is never announced (no live region on the card).
- During a Live search, the status line under the table (`Waiting for players: …`) is hidden.
- Nothing may spill over the table on small phones. If needed, the area below the table scrolls, and the buttons stay reachable.
- No new stat, no worker change, no join-time tracking. No join animation yet (spec, "Later").
- Mobile: no ESLint (see issue #144). Run `npm run typecheck` and `npm test`. Don't run `expo lint`.

## Review Focus

1. **A viewer who isn't seated** (claimant or stranger on a searching table): the roster has no `You` row and starts from the first seat. Test in Task 1.
2. **Elapsed past the fill time, or a negative elapsed time** (server late, clock skew): the bar clamps to 0–1 and the time to `0:00`. It never goes negative or past full. Test in Task 1.
3. **Someone leaves the lobby** (a player cancels): the row goes back to `Searching…`, and no "joined" announcement fires. Tests in Tasks 3 and 5.
4. **The stats request fails, or the player has played 0 games:** tips only, with no empty stats page. Test in Task 1 (`lobbyCards`) and the screen tests (Tasks 4 and 6).
5. **The search ends without the table filling** (Cancel, or the match is deleted): no "Table full" hold, and the screen navigates as before. Test in Task 2 / Task 5 (`useLobbyHold` only holds when the table is full).

---

### Task 0: Install dependencies

- [ ] **Step 1:** In `cloudflare/`, run `npm ci`. Expected: it completes and `cloudflare/node_modules` exists. (This worktree has none yet.)
- [ ] **Step 2:** In `cloudflare/`, run `npm run typecheck`. Expected: passes. This is the baseline. If it fails before any change, stop and report.

### Task 1: Shared lobby logic and tips (`@fortytwo/client`)

**Files:**
- Create: `cloudflare/packages/client/src/searchLobby.ts`
- Create: `cloudflare/packages/client/src/searchLobby.test.ts`
- Modify: `cloudflare/packages/client/src/index.ts` (add `export * from './searchLobby';`)

**Interfaces:**
- Produces:
  ```ts
  export const LOBBY_CARD_MS = 9000;
  export const LOBBY_FULL_HOLD_MS = 1200;
  export const SEARCH_TIPS: readonly string[];
  export function fillProgress(elapsedMs: number): { fraction: number; remainingMs: number };
  export function lobbyRoster(players: MatchPlayerRef[], viewerId: string): (string | null)[]; // length 4, playerIds
  export type LobbyCard =
    | { kind: 'tip'; text: string }
    | { kind: 'summary'; items: { label: string; value: string }[] }
    | { kind: 'favoriteTrump'; trump: string; record: string }
    | { kind: 'bestPartner'; name: string; record: string };
  export function lobbyCards(stats: StatsSummary | null | undefined, tips?: readonly string[]): LobbyCard[];
  export function joinAnnouncement(previous: (string | null)[], next: (string | null)[], nameOf: (id: string) => string | null): string | null;
  ```

- [ ] **Step 1: Write the failing tests** in `searchLobby.test.ts`:

```ts
describe('fillProgress', () => {
  it('runs from empty to full over LIVE_FILL_MS', () => {
    expect(fillProgress(0)).toEqual({ fraction: 0, remainingMs: LIVE_FILL_MS });
    expect(fillProgress(LIVE_FILL_MS / 2)).toEqual({ fraction: 0.5, remainingMs: LIVE_FILL_MS / 2 });
  });
  it('clamps past the fill and before the start', () => {
    expect(fillProgress(LIVE_FILL_MS + 5000)).toEqual({ fraction: 1, remainingMs: 0 });
    expect(fillProgress(-3000)).toEqual({ fraction: 0, remainingMs: LIVE_FILL_MS });
  });
});

describe('lobbyRoster', () => {
  const seat = (playerId: string, position: number) => ({ playerId, position, ready: false }) as MatchPlayerRef;
  it('puts the viewer first, then the seats after theirs in order, empty ones as null', () => {
    expect(lobbyRoster([seat('a', 0), seat('me', 2)], 'me')).toEqual(['me', null, 'a', null]);
  });
  it('starts from the first seat for a viewer without a seat', () => {
    expect(lobbyRoster([seat('a', 1)], 'stranger')).toEqual([null, 'a', null, null]);
  });
});

describe('lobbyCards', () => {
  const tips = ['t1', 't2', 't3', 't4'];
  it('is tips only without stats, or with none played', () => {
    expect(lobbyCards(undefined, tips)).toEqual(tips.map((text) => ({ kind: 'tip', text })));
    expect(lobbyCards({ ...STATS, played: 0 }, tips).every((c) => c.kind === 'tip')).toBe(true);
  });
  it('starts on a tip, then the summary, alternating stats pages with tips', () => {
    expect(lobbyCards(STATS, tips).map((c) => c.kind)).toEqual(['tip', 'summary', 'tip', 'favoriteTrump', 'tip', 'bestPartner', 'tip']);
  });
  it('uses the profile labels and formatting', () => {
    const summary = lobbyCards(STATS, tips)[1];
    expect(summary).toEqual({ kind: 'summary', items: [
      { label: 'Played', value: '23' }, { label: 'Won', value: '14' }, { label: 'Made rate', value: rateAsProfileShowsIt },
    ] });
  });
  it('leaves out favorite trump and best partner when there are none', () => {
    expect(lobbyCards({ ...STATS, favoriteTrump: null, bestPartner: null }, tips).map((c) => c.kind)).toEqual(['tip', 'summary', 'tip', 'tip', 'tip']);
  });
});

describe('joinAnnouncement', () => {
  const nameOf = (id: string) => (id === 'jo' ? 'Grandma Jo' : null);
  it('names who joined and the count', () => {
    expect(joinAnnouncement(['me', null, null, null], ['me', 'jo', null, null], nameOf)).toBe('Grandma Jo joined, 2 of 4');
  });
  it('says a player joined while the name loads', () => {
    expect(joinAnnouncement(['me', null, null, null], ['me', null, 'x', null], nameOf)).toBe('A player joined, 2 of 4');
  });
  it('says nothing when someone leaves or nothing changed', () => {
    expect(joinAnnouncement(['me', 'jo', null, null], ['me', null, null, null], nameOf)).toBeNull();
    expect(joinAnnouncement(['me', 'jo', null, null], ['me', 'jo', null, null], nameOf)).toBeNull();
  });
});

describe('SEARCH_TIPS', () => {
  it('has at least ten short, distinct tips', () => {
    expect(SEARCH_TIPS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(SEARCH_TIPS).size).toBe(SEARCH_TIPS.length);
    for (const tip of SEARCH_TIPS) expect(tip.length).toBeLessThanOrEqual(140);
  });
  it('tells the player people can still join after bots start', () => {
    expect(SEARCH_TIPS.some((t) => /still join/i.test(t))).toBe(true);
  });
});
```

`STATS` is the `all` summary from `apps/mobile/src/dev/devBypass.ts:74` (played 23, won 14, bidsWon 41, bidsMade 30, favoriteTrump sixes ×12, bestPartner Grandma Jo 7–2). `rateAsProfileShowsIt` is whatever `statSections(STATS)` gives for `Made rate`. Read it from there in the test rather than typing it in.

- [ ] **Step 2:** Run `npx vitest run src/searchLobby.test.ts` in `cloudflare/packages/client`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `searchLobby.ts`.
  - `lobbyRoster` rotates positions starting at the viewer's position, or at 0 if the viewer isn't seated.
  - `lobbyCards` picks `Played`, `Won` and `Made rate` from `statSections(stats)` by label. The stats pages are `[summary, favoriteTrump?, bestPartner?]`. Interleave them as tip, stat, tip, stat… and then append the remaining tips. `favoriteTrump.trump = trumpLabel(t.trump)`, `record = favoriteTrumpRecord(t, stats.bidsWon)`. `bestPartner.name = bp.user.displayName`, `record = bestPartnerRecord(bp)`.
  - `joinAnnouncement` fires only when the count of non-null entries grows. It names the first id that is in `next` but not in `previous`.
  - `SEARCH_TIPS` is exactly this copy. Each line restates a line in `HOW_TO_PLAY` or the claim bar's wording. Use real apostrophes (’) as `howToPlay.ts` does:

```ts
export const SEARCH_TIPS: readonly string[] = [
  'Every hand has 42 points: 35 in the count dominoes, plus 1 for each of the seven tricks.',
  'The 5-5 and 6-4 are worth 10 points each. The 5-0, 4-1 and 3-2 are worth 5.',
  'A double is the highest domino of its suit: the 4-4 beats every other four.',
  'A trump belongs only to trump. With sixes trump, the 6-4 is a six, never a four.',
  'A domino that isn’t trump leads as its higher end: lead the 5-3 and fives are the suit led.',
  'Bid 84 and your team must take all 42 points - for 2 marks instead of 1.',
  'A Plunge needs four or more doubles. Your partner names trump, and your team must take every trick.',
  'If the first three players pass, the last player has to bid.',
  'Once the bid is 42 or more, the bidder can call Follow Me or Low instead of naming a trump.',
  'On Low the bidder must lose every trick, and their partner sits the hand out.',
  'Can’t follow the suit led? Play anything - including a trump.',
  'A hand ends as soon as it’s decided, so you won’t always play all seven tricks.',
  'Start with bots and players can still join: each takes over a bot’s seat when a hand ends.',
];
```

- [ ] **Step 4:** Run the same command. Expected: PASS. Then run `npm test` and `npm run typecheck` in `cloudflare/packages/client`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(client): lobby roster, fill progress, cards and tips for the Live search (#138)`.

### Task 2: `useLobbyHold`, and stats fetched on demand (both apps)

**Files:**
- Create: `cloudflare/apps/mobile/src/match/useLobbyHold.ts`, test `cloudflare/apps/mobile/src/match/__tests__/useLobbyHold.test.tsx`
- Create: `cloudflare/apps/web/src/match/useLobbyHold.ts`, test `cloudflare/apps/web/src/match/useLobbyHold.test.tsx`
- Modify: `cloudflare/apps/mobile/src/api/useStats.ts` (add `{ enabled?: boolean }`, default `true`)
- Create: `cloudflare/apps/web/src/api/useStats.ts`. Modify `cloudflare/apps/web/src/components/PlayerStats.tsx` to use it (same `['stats']` query).

**Interfaces:**
- Produces: `useLobbyHold(searching: boolean, full: boolean): boolean`. It's true while `searching`. After `searching` turns false *with* `full` true, it stays true for `LOBBY_FULL_HOLD_MS`. It's never true if this mount never saw `searching`. Ending without `full` (Cancel, deleted) means no hold.
- Produces: `useStats(options?: { enabled?: boolean })`. Same return as today's `useQuery`.

- [ ] **Step 1: Write the failing hook tests** (same cases in both apps, with fake timers and `renderHook`):
  - `holds the lobby for LOBBY_FULL_HOLD_MS after the table fills`: render with `(true, false)`, rerender with `(false, true)`. Expect `true`. Advance by `LOBBY_FULL_HOLD_MS - 1`: still `true`. Advance by 1: `false`.
  - `does not hold when the search ends without filling`: `(true, false)` → `(false, false)` gives `false` at once.
  - `does not hold at a table that was full on arrival`: first render `(false, true)` gives `false`.
- [ ] **Step 2:** Run `npx jest src/match/__tests__/useLobbyHold.test.tsx` (mobile) and `npx vitest run src/match/useLobbyHold.test.tsx` (web). Expected: FAIL.
- [ ] **Step 3: Implement** both hooks (a ref that records whether it was ever searching, plus a timeout cleared on unmount), and the `useStats` changes.
- [ ] **Step 4:** Run the hook tests, plus the existing stats tests (`src/components/__tests__/playerStats.test.tsx` mobile, `src/components/PlayerStats.test.tsx` web). Expected: PASS.
- [ ] **Step 5: Commit** `feat: hold the Live lobby briefly once the table fills (#138)`.

### Task 3: Mobile `SearchLobby` and card carousel, and open seats that pulse

**Files:**
- Create: `cloudflare/apps/mobile/src/components/SearchLobby.tsx`
- Create: `cloudflare/apps/mobile/src/components/LobbyCarousel.tsx`
- Modify: `cloudflare/apps/mobile/src/components/Table.tsx` (new optional prop `searching?: boolean`. When true, open `SeatPlate`s get a pulsing brass border, in the same style as `PulsingGlow`, including the reduced-motion check.)
- Test: `cloudflare/apps/mobile/src/components/__tests__/searchLobby.test.tsx`

**Interfaces:**
- Consumes: Task 1's `LobbyCard`, `LOBBY_CARD_MS`, `fillProgress`, `joinAnnouncement`.
- Produces:
  ```ts
  export function SearchLobby(props: {
    roster: (string | null)[];          // from lobbyRoster
    viewerId: string;
    nameOf: (playerId: string) => string | null;  // null while loading → NameSkeleton
    online: number | null;
    elapsedMs: number | null;           // null → no bar (bots off)
    full: boolean;                      // true → "Table full" in place of the bar
    cards: LobbyCard[];
    onStartWithBots: (() => void) | null; // null → no button
    startDisabled: boolean;
    onCancel: () => void;
    cancelDisabled: boolean;
  }): JSX.Element;
  export function LobbyCarousel(props: { cards: LobbyCard[] }): JSX.Element;
  ```
- Layout and colours as in the mockup, using `colors` and `fonts` from `theme.ts`. The heading is `Finding players` in `fonts.display`. The carousel is a horizontal paged `ScrollView` (`pagingEnabled`) with dots. It advances with `scrollTo` every `LOBBY_CARD_MS`, unless reduce motion is on, the user is touching it (`onTouchStart`/`onTouchEnd`), or less than `LOBBY_CARD_MS` has passed since a manual swipe (`onMomentumScrollEnd` from a user drag). Announce joins with `AccessibilityInfo.announceForAccessibility(joinAnnouncement(prev, roster, nameOf))`, keeping the previous roster in a ref.

- [ ] **Step 1: Write the failing tests** in `searchLobby.test.tsx`:
  - `shows the heading, online count, bar time and roster`: roster `['me','jo',null,null]`, nameOf `{me: 'Me', jo: 'Grandma Jo'}`, online 14, elapsedMs `LIVE_FILL_MS - 93_000`. Expect `Finding players`, `14 online`, `1:33 🤖`, `You`, `Grandma Jo`, and two `Searching…`.
  - `leaves out the online count and the bar when they're unknown or off`: online null, elapsedMs null. Expect no `/online/` and no `/🤖/`.
  - `says Table full once the table is full`: full true. Expect `Table full`, and no `/🤖/`.
  - `Start with bots and Cancel call back`: press each and expect each callback once. With `onStartWithBots: null`, no `Start with bots`.
  - `shows a tip first, with the stats page next`: cards from `lobbyCards(STATS, SEARCH_TIPS)`. Expect `Did you know` and the first tip's text. Expect `Your stats`, `Played` and `23` to be rendered (all pages are laid out in the ScrollView).
  - `announces a player joining, not one leaving`: spy on `AccessibilityInfo.announceForAccessibility`. Rerender from `['me',null,null,null]` to `['me','jo',null,null]`: called with `Grandma Jo joined, 2 of 4`. Rerender back to `['me',null,null,null]`: not called again.
  - `moves to the next card on its own`, with fake timers and `isReduceMotionEnabled` resolving false: advancing `LOBBY_CARD_MS` calls the ScrollView's `scrollTo` with `x` = one page width. Spy on it via the ref, or assert the active dot moves (dots get `accessibilityState={{ selected }}`).
- [ ] **Step 2:** Run `npx jest src/components/__tests__/searchLobby.test.tsx` in `cloudflare/apps/mobile`. Expected: FAIL.
- [ ] **Step 3: Implement** `SearchLobby`, `LobbyCarousel` and the `Table` `searching` prop.
- [ ] **Step 4:** Run the test file and `src/components/__tests__/components.test.tsx` (the existing Table tests). Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): the Live search lobby component (#138)`.

### Task 4: Mobile match screen wiring and dev scenarios

**Files:**
- Modify: `cloudflare/apps/mobile/src/app/match/[id].tsx`. Its parts: the `center` block at `:678-759`, the status/panel switch at `:764-839`, and the hand at `:862`.
- Modify: `cloudflare/apps/mobile/src/dev/devMatches.ts`
- Test: `cloudflare/apps/mobile/src/match/__tests__/matchScreen.test.tsx` (add `getStats: jest.fn().mockResolvedValue(STATS)` and `addBots` to `mockApi`)

**Interfaces:**
- Consumes: `SearchLobby` (Task 3), `useLobbyHold` and `useStats({ enabled })` (Task 2), `lobbyRoster`, `lobbyCards` and `SEARCH_TIPS` (Task 1).

The wiring:
- `const live = search?.mode === 'live'`
- `const lobby = useLobbyHold(live, (liveMatch?.players.length ?? 0) >= 4)`
- `const stats = useStats({ enabled: lobby })`

While `lobby` is true:
- Pass `searching` and `compact` to `<Table>`, with an empty `center` (`<View />`).
- Render `<SearchLobby>` in place of the status/panel block and the `<Hand>`, filling the space between the table and the bottom. Wrap it in a `ScrollView` when it overflows.
- `elapsedMs = config.data?.bots ? search?.elapsedMs ?? LIVE_FILL_MS : null`. While holding, `search` is null: pass `full`.
- Cancel is today's live Cancel handler (`leavingRef.current = true; leave.mutate()`), shown only while `!hasBeenDealt(match)`. During the hold, use a no-op with `cancelDisabled`.
- Remove the live-only lines from `center` (the `search?.mode === 'live'` texts and the `Start with bots` button). Daily and Custom are unchanged.

Dev scenarios:
- `dev-live-search` becomes `takeSeat(createMatch(DEV_PLAYER_ID, 'live'), 'dev|jo', 1)`. Update its comment line.
- Add `dev-live-filling`: like `dev-live-search`, but `connectDevMatchSocket` seats `dev|ray` after 4 s and `dev|beth` after 8 s, using the `move` path so the broadcast fires. That fills the table, so the hold and the deal can be seen. Add it to the header comment.

- [ ] **Step 1: Write the failing tests** in `matchScreen.test.tsx`, in a new `describe('Live search lobby')` with a `searching()` match: `mode: 'live'`, players `[p1]`, `searchStartedOn` 23 s ago, not dealt.
  - `shows the lobby below the table`: `getConfig` → `{ bots: true }`. Expect `Finding players`, `/2:0[67] 🤖/`, `You`, three `Searching…`, `Start with bots` and `Cancel`. Expect no `/Waiting for players/`, and no `/Bots take the empty seats/`.
  - `shows tips only when the stats fail to load`: `getStats` rejects. Expect `Did you know`, and no `Your stats`.
  - `Start with bots adds bots`: press it and expect `mockApi.addBots` called with `'match-1'`.
  - `holds the full lobby, then shows the table`: start with `searching()`, then `socket(dealtLiveWithBots())` and rerender. Expect `Table full`. After `LOBBY_FULL_HOLD_MS` (fake timers), expect no `Finding players`, and the hand to show.
  - `no lobby for a Daily search`: `searching()` with `mode: 'daily'`. Expect `/we'll notify you/`, and no `Finding players`.
- [ ] **Step 2:** Run `npx jest src/match/__tests__/matchScreen.test.tsx`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the wiring and the dev scenarios.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck` in `cloudflare/apps/mobile`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): show the Live search as a lobby below the table (#138)`.

### Task 5: Web `SearchLobby` and card carousel

**Files:**
- Create: `cloudflare/apps/web/src/components/SearchLobby.tsx`, `cloudflare/apps/web/src/components/SearchLobby.css`
- Test: `cloudflare/apps/web/src/components/SearchLobby.test.tsx`
- Modify: `cloudflare/apps/web/src/styles/match.css` (`.seat-open.searching .seat-plate` gets a pulsing brass border. Put the animation inside the existing `prefers-reduced-motion` guard pattern.)

**Interfaces:**
- Same props as the mobile `SearchLobby` (Task 3). The carousel lives inside `SearchLobby.tsx` as an internal `LobbyCarousel`. It's a CSS scroll-snap strip with dot `<button>`s (`aria-label="Card N of M"`, `aria-current` on the active one). It auto-advances every `LOBBY_CARD_MS` unless `matchMedia('(prefers-reduced-motion: reduce)')` matches, the pointer is over it, or a dot or swipe was used in the last `LOBBY_CARD_MS`.
- Joins are announced through a visually hidden `<p role="status">` (Bootstrap `visually-hidden`) holding the latest `joinAnnouncement`.
- Buttons use the existing classes: `action-button` for Start with bots, and `btn btn-outline-danger` for Cancel search.

- [ ] **Step 1: Write the failing tests**, mirroring Task 3's list. Use `getByRole('button', { name: 'Start with bots' })`, `getByRole('button', { name: /cancel search/i })`, the status region's text for the announcement, and `aria-current` on dot 2 after advancing `LOBBY_CARD_MS` with fake timers (stub `matchMedia` to not match).
- [ ] **Step 2:** Run `npx vitest run src/components/SearchLobby.test.tsx` in `cloudflare/apps/web`. Expected: FAIL.
- [ ] **Step 3: Implement** the component, the CSS and the seat pulse. Match the mockup and the colours in `hall.css`.
- [ ] **Step 4:** Run the test file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the Live search lobby component (#138)`.

### Task 6: Web match page wiring

**Files:**
- Modify: `cloudflare/apps/web/src/pages/Match.tsx`. Its parts: the live block in `.table-center` at `:844-864`, the open seats at `:823-839`, and the `.player` area at `:938-1058`.
- Test: `cloudflare/apps/web/src/pages/Match.test.tsx` (`describe('Live and Async')` at `:2096`. Add `getStats: getStatsMock` to the `apiClient` mock.)

**Interfaces:**
- Consumes: the web `SearchLobby` (Task 5), `useLobbyHold` and `useStats({ enabled })` (Task 2), and Task 1's helpers. The wiring is the same as Task 4's.

While `lobby` is true:
- Add the `searching` class to each `.seat-open`.
- `.table-center` renders nothing for Live.
- `.player` renders `<SearchLobby>` in place of `rail-status` and `<Hand>`.

- [ ] **Step 1: Update and add tests:**
  - Replace `shows a Live search counting up, who is online, Start now with bots and Cancel search` with `shows the Live search lobby: bar, online count, roster, Start with bots and Cancel search`. Expect `Finding players`, `4 online`, `/2:0[67] 🤖/`, `You`, and `Start with bots` calling `addBotsMock` with `('match-1', undefined)`. Expect no `/bots take the empty seats/i`.
  - Rename `hides Start now with bots…` to use `Start with bots`. Also expect no `/🤖/`.
  - Add: `shows tips only when the stats fail` and `holds the full lobby, then shows the table`, as in Task 4.
- [ ] **Step 2:** Run `npx vitest run src/pages/Match.test.tsx`. Expected: the changed tests FAIL.
- [ ] **Step 3: Implement** the wiring.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck` in `cloudflare/apps/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): show the Live search as a lobby below the table (#138)`.

### Task 7: See it working

- [ ] **Step 1:** In `cloudflare/`, run `npm test` and `npm run typecheck`. Expected: all pass. (Worker tests need Node 25 under vitest-pool-workers 0.5 if master hasn't taken the Vitest 4 upgrade. The worker is unchanged, so a failure there that also fails on master isn't from this branch. Say so if it happens.)
- [ ] **Step 2:** Mobile, using the `mobile-emulator` skill: open `match/dev-live-search` and `match/dev-live-filling`. Screenshot each, both on the default device and on a small one (360×640 dp or the smallest available AVD). Check that nothing overlaps the table, the buttons are visible, the cards page, and `dev-live-filling` shows `Table full` and then the deal.
- [ ] **Step 3:** Web: run the web app against a local worker (or reuse the match page in a test harness). Screenshot a Live search at desktop width and at 375 px wide.
- [ ] **Step 4:** Show the screenshots to the user. The join animation is still open (spec, "Later"): ask whether they want one now that they can see the build.
