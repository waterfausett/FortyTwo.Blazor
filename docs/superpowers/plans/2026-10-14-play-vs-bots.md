# Play vs bots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One tap in the New match chooser (web and mobile) starts a dealt match against three ML bots.

**Architecture:** A new match mode, `bots`. One worker route, `POST /api/matches/bots`, calls a new
`MatchDO.createVsBots` that creates the match, seats the caller in seat 0, fills seats 1–3 with
bots (the 4th seat deals) and saves once. Clients add a "Practice" group to the chooser and show
the existing mid-game "Leave game" button for bots matches; leaving one deletes it.

**Tech Stack:** TypeScript, Hono on Cloudflare Workers + Durable Objects + D1 (vitest-pool-workers),
React web app (vitest + Testing Library), Expo/React Native app (jest + RNTL), npm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-14-play-vs-bots-design.md`

## Global Constraints

- All commands run from `cloudflare/` (the npm workspace root) unless stated.
- The mode string is exactly `'bots'`; its lobby label is exactly `'vs Bots'`.
- The chooser group is labelled **Practice**; its one option is **Play vs bots**, detail
  **"Jump straight in against three bots."**
- The route is `POST /api/matches/bots`; 404 `{ title: 'Not found' }` when `BOTS_ENABLED` is `'false'`; `201` with `matchViewFor(match, userId)` on success.
- The caller always sits at position 0; bots at 1, 2, 3.
- The option is hidden whenever Live Play is (bots off) — the existing `liveEnabled` prop.
- No D1 migration (`matches.mode` is plain `TEXT`).
- Worker tests: if vitest-pool-workers fails to start on Node 26, switch to Node 25.7 (`nvm use 25.7`).
- Commit messages are conventional (`feat(worker): …`, `feat(web): …`, `feat(mobile): …`) and end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Double tap on "Play vs bots"** — the option is disabled while the request is pending (`pending` prop), so only one match is created. Covered by the existing `disabled={pending}`; Task 3/4 tests assert the option is disabled when `pending`.
- **A bot opens the first hand** — the game must not stall waiting on a bot. `createVsBots` must call `schedule(match)`; Task 2 asserts an alarm is set when the opener is a bot (or the caller holds the turn).
- **Leaving a finished bots match** — must not delete the match from Game History. Task 2 asserts leaving after `winningTeam` is set does not take the drop path.
- **Rematch of a bots match** — stays a bots match (`createRematch` copies `mode`, `matchEngine.ts:475`). Task 2 adds a test only if `matchDORematch.test.ts` already has a finish-the-match helper; otherwise check it by hand in Task 5.
- **Bots off while the chooser is open on an old config** — the server 404s; the client shows the existing error alert (`startMatch.isError`). No new code; covered by Task 2's 404 test.

---

### Task 1: The `bots` mode, its label, and the client call

**Files:**
- Modify: `packages/rules/src/live.ts:9`
- Modify: `packages/api-types/src/index.ts:16`
- Modify: `packages/client/src/lobby.ts:18`
- Modify: `packages/client/src/api.ts:86-90`
- Test: `packages/client/src/lobby.test.ts:32-36`

**Interfaces:**
- Produces: `MatchMode = 'live' | 'daily' | 'custom' | 'bots'` (both packages); `MODE_LABELS.bots === 'vs Bots'`; `createApiClient(...).playBots(): Promise<MatchState>` → `POST /api/matches/bots`.

- [ ] **Step 1: Write the failing test** — in `packages/client/src/lobby.test.ts`, replace the `MODE_LABELS` block:

```ts
describe('MODE_LABELS', () => {
  it('calls the matchmade modes Live Play and Async, and a bots match vs Bots', () => {
    expect(MODE_LABELS).toEqual({ live: 'Live Play', daily: 'Async', custom: 'Custom', bots: 'vs Bots' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm test -w packages/client -- lobby`
Expected: FAIL — received object lacks `bots`.

- [ ] **Step 3: Implement**

`packages/rules/src/live.ts:9` and `packages/api-types/src/index.ts:16`:

```ts
export type MatchMode = 'live' | 'daily' | 'custom' | 'bots';
```

Update the comment above `MatchMode` in `api-types` only if it lists the modes.

`packages/client/src/lobby.ts:18`:

```ts
export const MODE_LABELS: Record<MatchMode, string> = { live: 'Live Play', daily: 'Async', custom: 'Custom', bots: 'vs Bots' };
```

`packages/client/src/api.ts`, after `play`:

```ts
    // A match against three bots, dealt and under way: the caller in seat 0, bots in the rest.
    playBots: (): Promise<MatchState> => request<MatchState>('/api/matches/bots', { method: 'POST' }),
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -w packages/client -- lobby` → PASS.
Run: `npm run typecheck` → no errors. (If a `Record<MatchMode, …>` elsewhere now misses `bots`, add the entry there, following its neighbours.)

- [ ] **Step 5: Commit**

```bash
git add packages
git commit -m "feat(worker): add the bots match mode and playBots client call"
```

---

### Task 2: Worker — create a bots match, and leave one

**Files:**
- Modify: `apps/worker/src/matchDO.ts` (new `createVsBots` after `create` ~line 120; `leave` ~line 199)
- Modify: `apps/worker/src/routes/matches.ts` (new route after `matches.post('/', …)` ~line 60)
- Test: `apps/worker/test/routes.matches.test.ts` (inside `describe('bots', …)` ~line 636)
- Test: `apps/worker/test/matchDOLeave.test.ts`

**Interfaces:**
- Consumes: `MatchMode` incl. `'bots'` (Task 1).
- Produces: `MatchDO.createVsBots(playerId: string, matchId: string): Promise<MatchState>`; `POST /api/matches/bots`.

- [ ] **Step 1: Write the failing route tests** — add inside `describe('bots', …)` in `routes.matches.test.ts`:

```ts
    it('starts a dealt match against three bots, the caller in seat 0', async () => {
      const p1 = await signToken('p1');

      const res = await apiWithBots('/api/matches/bots', p1, { method: 'POST' });

      expect(res.status).toBe(201);
      const match = (await res.json()) as MatchState;
      expect(match.mode).toBe('bots');
      expect(match.players.find((p) => p.playerId === 'p1')?.position).toBe(0);
      expect(match.players.filter((p) => p.playerId.startsWith('bot-')).map((p) => p.position).sort()).toEqual([1, 2, 3]);
      expect(match.currentGame.dealtOn).toBeTruthy();
      const row = await testEnv.DB.prepare('SELECT player_count, mode FROM matches WHERE id = ?')
        .bind(match.id)
        .first<{ player_count: number; mode: string }>();
      expect(row).toEqual({ player_count: 4, mode: 'bots' });
    });

    it('404s a bots match when bots are turned off', async () => {
      const p1 = await signToken('p1');
      const res = await apiWithBots('/api/matches/bots', p1, { method: 'POST' }, 'false');
      expect(res.status).toBe(404);
    });

    it('deletes a bots match, and its lobby row, when the player leaves mid-game', async () => {
      const p1 = await signToken('p1');
      const match = (await (await apiWithBots('/api/matches/bots', p1, { method: 'POST' })).json()) as MatchState;

      const res = await apiWithBots(`/api/matches/${match.id}/players`, p1, { method: 'DELETE' });

      expect(res.status).toBe(204);
      const row = await testEnv.DB.prepare('SELECT id FROM matches WHERE id = ?').bind(match.id).first();
      expect(row).toBeNull();
    });
```

(If `match.currentGame.dealtOn` isn't on the caller's view, assert instead that the caller's hand has 7 dominoes: `expect(match.currentGame.hands.find((h) => h.playerId === 'p1')?.dominoes).toHaveLength(7)`.)

- [ ] **Step 2: Write the failing DO tests** — add to `describe('MatchDO leave', …)` in `matchDOLeave.test.ts`:

```ts
  it('deletes a bots match left mid-game', async () => {
    const stub = stubFor('leave-bots-mode');
    await stub.createVsBots('p1', 'leave-bots-mode');

    expect(await stub.leave('p1')).toEqual({ ok: true, value: { deleted: true } });
    expect(await storedKeys(stub)).toBe(0);
  });

  it('starts the bots moving when a bot holds the first turn', async () => {
    const stub = stubFor('bots-mode-alarm');
    const match = await stub.createVsBots('p1', 'bots-mode-alarm');

    const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    if (match.currentGame.currentPlayerId === 'p1') expect(alarm).toBeNull();
    else expect(alarm).not.toBeNull();
  });

  it('keeps a finished bots match when the player leaves', async () => {
    const stub = stubFor('leave-bots-finished');
    await stub.createVsBots('p1', 'leave-bots-finished');
    await runInDurableObject(stub, async (_i, state) => {
      const m = (await state.storage.get<MatchState>('match'))!;
      await state.storage.put('match', { ...m, winningTeam: m.players[0].team ?? 1 });
    });

    const result = await stub.leave('p1');

    expect(result.ok && result.value.deleted).not.toBe(true);
  });
```

Add `type MatchState` to the `@fortytwo/rules` import. For the third test: if `players[i].team` isn't a field, use `Teams.TeamA` (import `Teams`). Any non-ok result (e.g. the existing "can't leave once dealt" 400) also passes — the point is the match isn't dropped; additionally assert `expect(await stub.getMatch()).toMatchObject({ ok: true })`.

Add a rematch check to `matchDORematch.test.ts` only if it has a helper that finishes a match; otherwise rely on `createRematch` copying `mode` (`packages/rules/src/matchEngine.ts:475`) and skip.

- [ ] **Step 3: Run them to see them fail**

Run: `npm test -w apps/worker -- routes.matches matchDOLeave`
Expected: FAIL — route 404s (no route), `createVsBots` is not a function.

- [ ] **Step 4: Implement `createVsBots`** — in `matchDO.ts`, after `create`:

```ts
  // A match against three bots (the 'bots' mode): the player in seat 0 and bots in the rest, so
  // the 4th seat deals and it's under way when it's returned. Saved once, so there's never a
  // half-built table. `schedule` starts the bots off if one of them opens.
  async createVsBots(playerId: string, matchId: string): Promise<MatchState> {
    const match = seatBots({ ...createMatch(playerId, 'bots'), id: matchId });
    await this.save(match);
    this.publish(null, match);
    await this.schedule(match);
    return match;
  }
```

Check `createMatch` seats the first player at position 0; if not, add `expect(position).toBe(0)` coverage already in Step 1 will catch it — then seat explicitly with `takeSeat` instead.

- [ ] **Step 5: Implement the leave case** — in `leave`, widen the Live-under-way branch so a bots match under way takes it (bots never count as present, so `othersPresent` is false and it drops):

```ts
      const mode = matchMode(match);
      // A Live game under way gives the seat to a bot, or ends when nobody else is present; a bots
      // match under way always ends (nobody else is ever present).
      if ((mode === 'live' || mode === 'bots') && hasBeenDealt(match) && match.winningTeam === null) {
```

and update the method's comment above (`leave(playerId: string)`) to mention bots matches.

- [ ] **Step 6: Implement the route** — in `routes/matches.ts`, after `matches.post('/', …)`:

```ts
// One tap to a match against three bots: created, seated, dealt (MatchDO's `createVsBots`).
// Off with bots, as adding them is.
matches.post('/bots', async (c) => {
  if (!botsEnabled(c.env)) return c.json({ title: 'Not found' }, 404);
  const matchId = crypto.randomUUID();
  const userId = c.get('user').sub;
  const match = await matchStub(c.env, matchId).createVsBots(userId, matchId);
  await bestEffort(matchId, () => syncLobbyIndex(c.env.DB, match));
  return c.json(matchViewFor(match, userId), 201);
});
```

- [ ] **Step 7: Run the tests**

Run: `npm test -w apps/worker` → all PASS (whole suite, since `leave` changed).
Run: `npm run typecheck -w apps/worker` → no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/worker
git commit -m "feat(worker): one-tap match against three bots (#111)"
```

---

### Task 3: Web — Practice option, Lobby wiring, Leave game

**Files:**
- Modify: `apps/web/src/components/NewMatchDialog.tsx`
- Modify: `apps/web/src/pages/Lobby.tsx:102-104`
- Modify: `apps/web/src/pages/Match.tsx` (~line 1014-1015, the "Leave game" condition)
- Test: `apps/web/src/components/NewMatchDialog.test.tsx`, `apps/web/src/pages/Lobby.test.tsx`, `apps/web/src/pages/Match.test.tsx`

**Interfaces:**
- Consumes: `client.playBots()` (Task 1), `'bots'` mode.
- Produces: `NewMatchChoice = 'live' | 'daily' | 'challenge' | 'bots'`.

- [ ] **Step 1: Write the failing dialog tests** — in `NewMatchDialog.test.tsx`, add:

```tsx
  it('offers Play vs bots under Practice', () => {
    const onChoose = vi.fn();
    render(<NewMatchDialog open liveEnabled online={null} pending={false} onChoose={onChoose} onClose={vi.fn()} />);
    const practice = screen.getByRole('group', { name: /practice/i });
    fireEvent.click(within(practice).getByRole('button', { name: /play vs bots/i }));
    expect(onChoose).toHaveBeenCalledWith('bots');
    expect(screen.getByText('Jump straight in against three bots.')).toBeTruthy();
  });

  it('leaves Play vs bots out when bots are off', () => {
    render(<NewMatchDialog open liveEnabled={false} online={null} pending={false} onChoose={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('group', { name: /practice/i })).toBeNull();
  });

  it('disables Play vs bots while a match is starting', () => {
    render(<NewMatchDialog open liveEnabled online={null} pending onChoose={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByRole('button', { name: /play vs bots/i }) as HTMLButtonElement).disabled).toBe(true);
  });
```

- [ ] **Step 2: Write the failing Lobby test** — in `Lobby.test.tsx`, add `playBotsMock` to the `vi.hoisted` block and the mocked client (`playBots: playBotsMock`), then after the Custom Match test:

```tsx
  it('starts a match against bots for Play vs bots', async () => {
    playBotsMock.mockResolvedValue({ id: 'bots-1' } as MatchState);
    renderLobby();
    fireEvent.click(await screen.findByRole('button', { name: /new match/i }));
    fireEvent.click(await screen.findByRole('button', { name: /play vs bots/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/match/bots-1'));
  });
```

- [ ] **Step 3: Write the failing Match test** — in `Match.test.tsx`, next to "says the game ends when you leave as the last player present":

```tsx
    it('offers Leave game in a bots match, which ends it', async () => {
      leaveMatchMock.mockResolvedValue(undefined);
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      useMatchSocketMock.mockReturnValue({ match: dealtLiveWithBots({ mode: 'bots' }), connected: true });
      renderMatch();
      fireEvent.click(await screen.findByRole('button', { name: 'Leave game' }));
      expect(confirm).toHaveBeenCalledWith('Leave this game? Nobody else is playing, so it ends.');
      await waitFor(() => expect(leaveMatchMock).toHaveBeenCalledWith('match-1'));
      confirm.mockRestore();
    });
```

(`dealtLiveWithBots` seats humans in some seats; if its other humans count as present, override `players` so only `currentUserId` is human, or add `autopilot` for the others as the neighbouring test does.)

- [ ] **Step 4: Run them to see them fail**

Run: `npm test -w apps/web -- NewMatchDialog Lobby Match`
Expected: the new tests FAIL.

- [ ] **Step 5: Implement the dialog** — in `NewMatchDialog.tsx`:

```ts
export type NewMatchChoice = 'live' | 'daily' | 'challenge' | 'bots';
```

append to `GROUPS`:

```ts
  {
    id: 'practice',
    label: 'Practice',
    icon: 'oi-laptop',
    options: [
      { choice: 'bots', title: 'Play vs bots', detail: 'Jump straight in against three bots.', icon: 'oi-media-play' },
    ],
  },
```

change the filter to hide anything that needs bots:

```ts
          const options = group.options.filter((o) => liveEnabled || (o.choice !== 'live' && o.choice !== 'bots'));
```

and update the file's header comment: "…three groups: Find opponents…, Play with friends…, and Practice (Play vs bots, straight into a game against three bots). Live and Play vs bots are left out while bots are off."

- [ ] **Step 6: Implement the Lobby wiring** — `Lobby.tsx`:

```tsx
  // Live and Async seat the player through matchmaking; Custom Match starts a custom table; Play
  // vs bots starts a game against three bots.
  const startMatch = useMutation({
    mutationFn: (choice: NewMatchChoice) =>
      choice === 'challenge' ? client.createMatch() : choice === 'bots' ? client.playBots() : client.play(choice),
```

- [ ] **Step 7: Implement Leave game** — `Match.tsx`, the rail button:

```tsx
            {/* A player can leave a game under way: in Live Play a bot takes their seat; a bots match ends. */}
            {(mode === 'live' || mode === 'bots') && hasBeenDealt(match) && !isMatchOver && !watching && (
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npm test -w apps/web` → PASS. Run: `npm run typecheck -w apps/web` → no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "feat(web): Play vs bots in the New match chooser (#111)"
```

---

### Task 4: Mobile — Practice option, Lobby wiring, Leave game

**Files:**
- Modify: `apps/mobile/src/components/NewMatchSheet.tsx`
- Modify: `apps/mobile/src/app/index.tsx:66-68`
- Modify: `apps/mobile/src/app/match/[id].tsx:533-534`
- Modify: `apps/mobile/src/dev/devBypass.ts:81-82`
- Test: `apps/mobile/src/components/__tests__/components.test.tsx`, `apps/mobile/src/match/__tests__/matchScreen.test.tsx`

**Interfaces:**
- Consumes: `api.playBots()` (Task 1), `'bots'` mode.
- Produces: mobile `NewMatchChoice = 'live' | 'daily' | 'challenge' | 'bots'`.

- [ ] **Step 1: Write the failing sheet tests** — in `describe('NewMatchSheet', …)`:

```tsx
  it('offers Play vs bots under Practice', async () => {
    const onChoose = jest.fn();
    await render(inApp(<NewMatchSheet visible liveEnabled online={null} pending={false} onChoose={onChoose} onClose={jest.fn()} />));
    expect(screen.getByRole('header', { name: /practice/i })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: /play vs bots.*jump straight in against three bots/i }));
    expect(onChoose).toHaveBeenCalledWith('bots');
  });

  it('leaves Play vs bots out when bots are off', async () => {
    await render(inApp(<NewMatchSheet visible liveEnabled={false} online={null} pending={false} onChoose={jest.fn()} onClose={jest.fn()} />));
    expect(screen.queryByRole('button', { name: /play vs bots/i })).toBeNull();
    expect(screen.queryByRole('header', { name: /practice/i })).toBeNull();
  });
```

- [ ] **Step 2: Write the failing match-screen test** — in `matchScreen.test.tsx`, after "offers Leave game in a Live Play game under way…":

```tsx
  it('offers Leave game in a bots match, which ends it', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    socket(dealtLiveWithBots({ mode: 'bots' }));
    await renderScreen();

    await fireEvent.press(await screen.findByText('Leave game'));
    expect(alert).toHaveBeenCalledWith('Leave this game?', 'Nobody else is playing, so it ends.', expect.any(Array));
    alert.mockRestore();
  });
```

(As on web: if `dealtLiveWithBots` seats other humans who count as present, add `autopilot` for them as the "last player present" test does.)

- [ ] **Step 3: Run them to see them fail**

Run: `npm test -w apps/mobile -- components matchScreen`
Expected: the new tests FAIL.

- [ ] **Step 4: Implement the sheet** — in `NewMatchSheet.tsx`, same shape as web:

```ts
export type NewMatchChoice = 'live' | 'daily' | 'challenge' | 'bots';
```

append to `GROUPS`:

```ts
  {
    id: 'practice',
    label: 'Practice',
    icon: 'hardware-chip',
    options: [{ choice: 'bots', title: 'Play vs bots', detail: 'Jump straight in against three bots.', icon: 'play' }],
  },
```

the filter (line ~90):

```ts
          const options = group.options.filter((o) => liveEnabled || (o.choice !== 'live' && o.choice !== 'bots'));
```

and the header comment, matching the web one.

- [ ] **Step 5: Implement the Lobby wiring** — `app/index.tsx`:

```tsx
  // Live and Async seat the player through matchmaking; Custom Match starts a custom table; Play
  // vs bots starts a game against three bots.
  const start = useMutation({
    mutationFn: (choice: NewMatchChoice) =>
      choice === 'challenge' ? api.createMatch() : choice === 'bots' ? api.playBots() : api.play(choice),
```

`dev/devBypass.ts`, after `play`:

```ts
  playBots: () => answer({ id: 'dev-new' } as MatchState),
```

- [ ] **Step 6: Implement Leave game** — `app/match/[id].tsx`:

```tsx
  // A player can leave a game under way: in Live Play a bot takes their seat; a bots match ends.
  const canLeaveGame = (mode === 'live' || mode === 'bots') && hasBeenDealt(match) && !view.isMatchOver && !watching;
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npm test -w apps/mobile` → PASS. Run: `npm run typecheck -w apps/mobile` (if the script exists; else `npx tsc --noEmit -p apps/mobile`) → no errors. Don't run `expo lint` (it rewrites the lockfile).

- [ ] **Step 8: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): Play vs bots in the New match sheet (#111)"
```

---

### Task 5: See it working

- [ ] **Step 1:** Run the whole suite: `npm test` and `npm run typecheck` from `cloudflare/` → all PASS.
- [ ] **Step 2: Web** — start the worker and web dev servers (see the `run` skill / repo README), sign in, New match → Practice → Play vs bots. Expect: lands on a dealt table, three "Bot N" seats, the bots bid/play in turn; the lobby row reads "vs Bots"; Leave game → confirm → back in the lobby and the row is gone.
- [ ] **Step 3: Mobile** — use the `mobile-emulator` skill: open the New match sheet, screenshot the Practice group, tap Play vs bots (dev bypass lands on `dev-new`; against a real worker it lands on the table).
- [ ] **Step 4:** Report what was seen, with screenshots; fix anything off in the owning task's files and re-run its tests.
