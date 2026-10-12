# How to play: a rules screen on web and mobile

Issue: [#112](https://github.com/waterfausett/FortyTwo.Blazor/issues/112)

## Goal

Someone who has never played Texas 42 can learn it from the app. A How to play screen on web and
mobile, reachable from the nav bar / Lobby and from inside a match, covers teams and seating, suits,
trump and doubles, bidding, counting dominoes, following suit and tricks, and scoring.

Success looks like:

- Web has a `/how-to-play` page and a "How to play" nav link; a match has a "?" that opens the same
  content in a dialog without leaving the table.
- Mobile has a `how-to-play` screen, opened from a "?" in the Lobby header and in the match header;
  back returns to where the player was.
- The copy is the same on both apps, and states only what the rules engine actually does.
- A first-time player sees a dismissible "New to 42? Learn how to play" card in the Lobby, on both
  apps, until they dismiss it or open the rules - remembered per account, not per device.

## Decisions

- The copy is shared, structured data in `@fortytwo/client` (no JSX, no Markdown); each app renders
  it with its own components, including its own `Domino` for diagrams.
- "Seen" lives in Auth0 `user_metadata.seenHowToPlay`, exactly like `highlightPlayable`, so it is
  shared across web and mobile.
- `seenHowToPlay` is set when the player dismisses the card **or** opens the rules (page, dialog or
  screen).
- One PR across worker, web and mobile. Release-please assigns changes by path, so both the worker
  and mobile changelogs pick it up whatever the title's scope.

## Out of scope

- The interactive first hand with a bot partner and hints (#76).
- A settings toggle to bring the card back.

## Rules the copy must match

From `packages/rules`, not general 42 lore:

- Four players, two teams; partners sit opposite. Seven dominoes each.
- A domino belongs to the suit of its higher end when led, unless it's a trump; a trump domino is
  only trump. A double normally tops its suit.
- Bids: Pass, 30-42, 84 (2 marks), then 3-7 Marks one rung at a time (3 Marks only over a standing
  84, 4 Marks over 3, ...). Each bid must beat the high bid. Anything above 42 needs every point.
- Plunge: needs four or more doubles, only while the high bid is under 4 Marks; worth 4 marks; the
  partner names trump; the team must take every trick; it can't go Low.
- Everyone can't pass: if the first three pass, the fourth must bid.
- At 42 or more the bidder may also call Follow Me (no trump) or Low (lose every trick), with one of
  three doubles rules: doubles high, doubles low, or doubles as their own suit (double-six highest).
  On Low the bidder's partner sits out, so each trick has three dominoes.
- Counters: 5-5 and 6-4 are 10, 5-0, 4-1 and 3-2 are 5 (35 in all) plus 1 point per trick (7):
  42 points a hand.
- Follow the suit led if you can; otherwise play anything, including trump. Highest trump wins,
  else the highest of the suit led; the winner leads next.
- A hand is decided as soon as the bid is made or can no longer be made. The winning team scores
  the hand's marks: 1 for a points bid, one per 42 bid above that (Plunge: 4).
- The first team to 7 marks (`WINNING_SCORE`) wins the match.

## Design

### Shared content - `packages/client/src/howToPlay.ts`

```ts
export type HowToPlayBlock =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'dominoes'; caption: string; dominoes: { top: number; bottom: number }[] };
export interface HowToPlaySection { id: string; title: string; blocks: HowToPlayBlock[] }
export const HOW_TO_PLAY: HowToPlaySection[];
```

Sections, in order: The game, Suits and trump, Doubles, Bidding, Counting dominoes, Playing tricks,
Scoring. Exported from `@fortytwo/client`'s index.

Alongside it:

- `DOUBLES_DETAIL` moves to `@fortytwo/client` (one wording); web `TrumpPicker`, mobile
  `TrumpPicker` and `DoublesRuleModal` import it. The Doubles section uses it too.
- `@fortytwo/rules` exports `WINNING_SCORE`; the Scoring section builds its target from it.

### Worker and API types

- `api-types`: `seenHowToPlay?: boolean` on `Auth0User.user_metadata` and `ProfilePatch`;
  `seenHowToPlay: boolean` on `UserProfile`.
- `requestBody.ts` `profilePatch`: `seenHowToPlay` via `setting(...)` (booleans only).
- `users/profile.ts` `toUserResponse`: `seenHowToPlay: u.user_metadata?.seenHowToPlay === true`
  (false until set). Not in `toPublicUser`.

### Web

- `pages/HowToPlay.tsx`: a `HowToPlayContent` component (renders `HOW_TO_PLAY`, domino blocks via
  `Domino`) inside a page with a section index; route `/how-to-play` in `main.tsx`.
- `NavBar`: "How to play" link.
- Match scoreboard: a "?" button opening a dialog with `HowToPlayContent`.
- Lobby: the card when `profile.seenHowToPlay === false` (strict: a profile from a worker that
  doesn't know the field shows nothing). × and opening the rules PATCH `{ seenHowToPlay: true }`,
  updating the cached profile optimistically. A shared `useMarkHowToPlaySeen` hook does the PATCH
  and skips it when the flag is already true.

### Mobile

- `app/how-to-play.tsx`: a `ScrollView` rendering `HOW_TO_PLAY` with the mobile `Domino`;
  registered in `_layout.tsx` (title "How to play", inside the signed-in guard).
- Lobby header: a "?" button beside `ProfileButton`; the same card under the header.
- Match screen: `headerRight` "?" pushing `/how-to-play`.
- Same seen logic as web, through `useProfile` and the existing profile PATCH.

## Testing

- Client: every section has a title and blocks; the counters diagram is exactly the dominoes with
  `dominoValue > 0` and they sum to 35; the copy's match target is `WINNING_SCORE`.
- Worker (`routes.users.test.ts`): default false, set from metadata, patch accepts booleans only,
  not in `toPublicUser`.
- Web: page renders every section; nav link; Lobby card shown only when the flag is `false`; ×
  and opening the page PATCH; the match "?" opens the dialog.
- Mobile (`screens.test.tsx`): screen renders every section; Lobby card and its ×; the header
  buttons navigate. Checked in the emulator.
