# Live Play searching screen — design

Issue: #138. Applies to the mobile match screen (`cloudflare/apps/mobile/src/app/match/[id].tsx`) and the web match page (`cloudflare/apps/web/src/pages/Match.tsx`).

## Why

A Live Play search can take up to 2½ minutes. Today the player sees an empty table, with the search status squeezed into the small middle of it (the mat), and nothing below. That wastes space and the wait feels like nothing is happening. The goal is a matchmaking-lobby feel, like the lobby in Halo or Call of Duty: the lobby fills as people arrive, the wait has a visible end, and there's something to read while waiting.

## Goals

- Move the search status and actions out of the mat and into the empty space below the table.
- Show the lobby filling: a roster of four that fills as players join, matched by seats filling on the table.
- Show progress toward the bot fill, so the wait has a visible end, instead of a clock counting up.
- Make the online count feel live.
- Give the player something to look at: a swipeable card of tips and their own stats.
- The same design on mobile and on the web match page.

## Non-goals

- **Daily and Custom waiting screens.** Leave them as they are unless sharing the work is clearly cheaper. They differ: Custom isn't searching and wouldn't show an online count, and Daily hasn't been thought through yet. They'll be redesigned later. If shared components fall out naturally, fine. Don't bend this design to fit them.
- **Join times.** The match doesn't record when each player sat down, and this design doesn't add that. The roster shows names only.
- **New stats.** No new stat is tracked. The card shows what the profile already shows.

## Anti-goals

- Don't make the screen more cramped than it is today on small phones.
- The tips must not say anything the rules engine doesn't do.

## The screen

Use the mockup `2026-10-16-live-search-screen-mockup.html` (next to this file; open it in a browser) as the reference. The "142 hands" in it is a placeholder: the real summary is Played / Won / Made rate. From top to bottom:

1. **Score row** as now.
2. **The table, smaller (compact).** Open seats show "Open" with a gentle pulsing border. A seat that fills shows the player's name, styled as filled like today. The player's own seat as now. The mat is empty: nothing in the middle.
3. **Heading row:** "Finding players" on the left, and on the right the online count with a small green dot that blinks slowly ("14 online"). If the online count is unavailable (`useOnline()` is null), leave it out.
4. **Progress bar toward the bot fill.** It fills from 0 at the start of the search to full at `LIVE_FILL_MS`. At its right end is the time remaining and a bot emoji ("1:33 🤖"). This replaces both the "Finding players… 0:12" clock and the "Bots take the empty seats at 2:30…" line. Drive it from `searchState(...).elapsedMs` and `LIVE_FILL_MS`. Only show it when bots are switched on (`config.bots`). Without bots there's no fill, so show no bar.
5. **Roster:** four rows in seat order, the player first.
   - Filled rows: avatar initial, then the display name (the same name the seat plate shows). The player's own row is marked "You" and has a turquoise left edge.
   - Empty rows: dashed outline, "?" avatar, "Searching…".
   - No join times.
6. **Swipeable card** (described below), with page dots underneath.
7. **Actions at the bottom:** **Start with bots** (filled brass button, shown when `config.bots`) and **Cancel** (outlined, danger colour). Same behaviour as today's buttons.

The status line under the table ("Waiting for players: 1 of 4 seated", `matchView.ts:178`) is hidden during a Live search, because the roster says the same thing.

### The card

- Two kinds of page: **Did you know** tips and **Your stats**.
- It moves to the next page on its own every 8–10 s, and the user can swipe it. Pause the timer while it's being touched or hovered, and for some seconds after a swipe.
- **Tips:** a new short list (about 10–15 one- or two-sentence tips), kept next to the How to play data in `packages/client/src/howToPlay.ts` so both apps share one copy. Write them from that content. Each one has to be true of `packages/rules`, and checked the way `howToPlay.test.ts` checks its content where that's possible (constants such as `WINNING_SCORE` rather than numbers typed in).
- **Stats:** from the player's existing stats (the same request and `StatsSummary` the profile uses, the "All" filter), with the profile's own labels from `statSections` in `packages/client/src/stats.ts`:
  - A summary page: Played, Won, Made rate.
  - Favorite trump, as its own page if present (same wording as the profile, `trumpLabel` / `favoriteTrumpRecord`).
  - Best partner, as its own page if present (`bestPartnerRecord`).
  - With no stats (nothing played, or the request failed or hasn't loaded), the stats pages don't appear. The card is just tips.

## When the table fills

When the fourth seat fills, keep the lobby on screen for a short moment: all four roster rows filled, and the bar replaced by something like "Table full". Then go straight into the normal match screen (the deal). Today the screen switches the moment `searchState` turns null. Add a short hold of about 1–1.5 s, on the client only. Don't hold if the player arrived at a table that was already full.

## Web

The same structure on the web match page. The status and actions panel goes in the area below the table where the hand sits during play, not in `.table-center`. The web currently says "Start now with bots": use **Start with bots** on both so they match. Fit it to the web's existing styles (`hall.css`, `match.css`).

## Constraints

- Small phones: everything must fit without spilling over the table, as fixed in 438c5dc. If space runs out, the card shrinks or the area below the table scrolls. The table and the action buttons never get cut off.
- Respect reduced motion: no seat pulse, no dot blink, and no automatic paging of the card (swiping still works).
- Accessibility: one polite live region announces players joining ("Maria joined, 2 of 4"), not the timer ticking. The card's automatic paging must not be announced.
- Emulator fixture: `./scripts/emulator.ps1 open match/dev-live-search` (from `cloudflare/apps/mobile`, sign-in bypassed). Update the dev-bypass stand-in data so it shows a partly filled roster and some stats.
- Update the tests that assert the old text (for example `Match.test.tsx`, "shows a Live search counting up…", and the mobile match screen tests).

## Calls made in writing this (not discussed with you)

- The bar only appears when bots are on.
- "Players can still join after you start" is gone from the screen. It becomes one of the tips instead.
- The card starts on a tip. The stats summary is the second page, and the other pages follow.
- The "table full" hold is about 1–1.5 s, client-side.
- The web button text is changed to "Start with bots".
- The Live-search status line under the table is hidden.
- A live-region announcement when a player joins.

## Later

- A subtle animation when a player joins (the roster row and/or the seat). It's wanted, but its form is still open: decide once the build can be seen. Leave room for it, and don't build one now.

## Left to the builder

The exact sizes, the animation curves, the order of the tips and the text of each tip, and the swipe implementation (a native one on mobile; on the web, swipe and buttons or the dots).
