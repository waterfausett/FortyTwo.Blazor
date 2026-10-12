# How to play Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A How to play screen on web and mobile, built from one shared copy, with a Lobby card that
first-time players see until they dismiss it or open the rules (remembered per account).

**Architecture:** The rules copy is plain data (`HOW_TO_PLAY`) in `@fortytwo/client`, rendered by a
`HowToPlayContent` component in each app with that app's `Domino`. "Seen" is a new Auth0
`user_metadata.seenHowToPlay` setting that runs through the worker exactly like `highlightPlayable`;
the decision to offer the card is one shared pure function.

**Tech Stack:** TypeScript, React 19 + react-router + TanStack Query (web, vitest + RTL), Expo
Router / React Native (mobile, jest-expo + RNTL), Hono worker on Cloudflare (vitest-pool-workers).

**Spec:** `docs/superpowers/specs/2026-10-11-how-to-play-design.md`

All commands run from `cloudflare/` unless noted.

## Global Constraints

- Copy states only what `packages/rules` does (see the spec's "Rules the copy must match").
- One doubles wording, from `@fortytwo/client`'s `DOUBLES_DETAIL`: `Each double tops its suit`,
  `Each double is the lowest of its suit`, `Doubles form a suit, double-six highest`.
- Match target in copy comes from `WINNING_SCORE` (7), never a literal.
- The card shows only when `profile.seenHowToPlay === false` (strictly); `markSeen` PATCHes only then.
- `@fortytwo/client` may not use React or browser-only APIs (its index header says so).
- PR title: `feat(web): how to play rules screen` (release-please assigns by path; one PR closes #112).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A profile from a worker that predates `seenHowToPlay` (field missing) → no card and no PATCH (Task 4 and 5 tests).
2. Profile still loading when the rules page opens → no PATCH until the profile arrives, then one (Task 4 test).
3. The PATCH fails → the card comes back (optimistic update rolled back), no crash (Task 4 test).
4. The in-match dialog closes with × and Escape and leaves the table as it was (Task 4 test).
5. Mobile: back from the rules screen returns to the same match, still connected (Task 5, emulator check).

---

### Task 1: Shared content and seen-decision in `@fortytwo/client`

**Files:**
- Modify: `packages/rules/src/matchEngine.ts:32-33` (export `WINNING_SCORE`)
- Modify: `packages/rules/src/index.ts` (re-export it)
- Create: `packages/client/src/howToPlay.ts`
- Create: `packages/client/src/howToPlay.test.ts`
- Modify: `packages/client/src/index.ts`

**Interfaces:**
- Produces: `HOW_TO_PLAY: HowToPlaySection[]`, `HowToPlaySection`, `HowToPlayBlock`,
  `DOUBLES_DETAIL: Record<(typeof LOW_TRUMPS)[number], string>`,
  `shouldOfferHowToPlay(profile: Pick<UserProfile,'seenHowToPlay'> | undefined): boolean` (Task 2 adds the field; until then type it as `{ seenHowToPlay?: boolean } | undefined`),
  and `WINNING_SCORE` from `@fortytwo/rules`.

- [ ] **Step 1: Export `WINNING_SCORE`.** In `matchEngine.ts` change `const WINNING_SCORE = 7;` to
  `export const WINNING_SCORE = 7;`, and add `WINNING_SCORE,` to the `./matchEngine` export list in
  `packages/rules/src/index.ts`.

- [ ] **Step 2: Write the failing test** `packages/client/src/howToPlay.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LOW_TRUMPS, WINNING_SCORE, createDomino, dominoValue } from '@fortytwo/rules';
import { DOUBLES_DETAIL, HOW_TO_PLAY, shouldOfferHowToPlay, type HowToPlayBlock } from './howToPlay';

const blocks = (id: string): HowToPlayBlock[] => HOW_TO_PLAY.find((s) => s.id === id)!.blocks;
const allText = HOW_TO_PLAY.flatMap((s) =>
  s.blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : b.kind === 'list' ? b.items : [b.caption]))
).join('\n');

describe('HOW_TO_PLAY', () => {
  it('has the seven sections in order, each with a title and blocks', () => {
    expect(HOW_TO_PLAY.map((s) => s.id)).toEqual(['game', 'suits', 'doubles', 'bidding', 'counting', 'tricks', 'scoring']);
    for (const s of HOW_TO_PLAY) {
      expect(s.title).not.toBe('');
      expect(s.blocks.length).toBeGreaterThan(0);
    }
  });

  it('shows exactly the counters, and they add up to 35', () => {
    const shown = blocks('counting').flatMap((b) => (b.kind === 'dominoes' ? b.dominoes : []));
    const all = [];
    for (let top = 0; top <= 6; top++) for (let bottom = 0; bottom <= top; bottom++) all.push(createDomino(top, bottom));
    const counters = all.filter((d) => dominoValue(d) > 0);
    const key = (d: { top: number; bottom: number }) => [d.top, d.bottom].sort().join('-');
    expect(shown.map(key).sort()).toEqual(counters.map(key).sort());
    expect(shown.reduce((sum, d) => sum + dominoValue(createDomino(d.top, d.bottom)), 0)).toBe(35);
  });

  it('names the match target from the rules engine', () => {
    expect(allText).toContain(`first team to ${WINNING_SCORE} marks`);
  });

  it('describes every Low doubles rule in the shared wording', () => {
    for (const suit of LOW_TRUMPS) expect(allText).toContain(DOUBLES_DETAIL[suit]);
  });
});

describe('shouldOfferHowToPlay', () => {
  it('offers the rules only when the profile says they have not been seen', () => {
    expect(shouldOfferHowToPlay({ seenHowToPlay: false })).toBe(true);
    expect(shouldOfferHowToPlay({ seenHowToPlay: true })).toBe(false);
    // A worker that doesn't know the field yet, or a profile still loading.
    expect(shouldOfferHowToPlay({})).toBe(false);
    expect(shouldOfferHowToPlay(undefined)).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to see it fail.** `npm test -w @fortytwo/client -- howToPlay` → FAIL (module not found).

- [ ] **Step 4: Implement** `packages/client/src/howToPlay.ts`:

```ts
// The How to play copy, as data both apps render with their own components (web
// HowToPlayContent, mobile HowToPlayContent) - one copy, so the two can't drift. Everything here
// states what packages/rules does; howToPlay.test.ts checks the parts that can be checked.
import { LOW_TRUMPS, Suit, WINNING_SCORE, lowDoublesToPrettyString } from '@fortytwo/rules';

export type HowToPlayBlock =
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'dominoes'; caption: string; dominoes: { top: number; bottom: number }[] };

export interface HowToPlaySection {
  id: string;
  title: string;
  blocks: HowToPlayBlock[];
}

// How doubles play under each Low trump, for the trump pickers, the doubles rule modal and the
// rules screen.
export const DOUBLES_DETAIL: Record<(typeof LOW_TRUMPS)[number], string> = {
  [Suit.Low]: 'Each double tops its suit',
  [Suit.LowDoublesLow]: 'Each double is the lowest of its suit',
  [Suit.LowDoublesOwnSuit]: 'Doubles form a suit, double-six highest',
};

const d = (top: number, bottom: number) => ({ top, bottom });

export const HOW_TO_PLAY: HowToPlaySection[] = [
  {
    id: 'game',
    title: 'The game',
    blocks: [
      {
        kind: 'text',
        text: 'Forty-Two is a trick-taking game for four players in two teams, played with a double-six set of 28 dominoes. Partners sit across the table from each other, so turns alternate between the teams.',
      },
      {
        kind: 'text',
        text: 'Each hand, everyone gets seven dominoes. The teams bid for the right to name trump, then play seven tricks. The bidding team has to take enough points to make its bid; the other team tries to stop them.',
      },
    ],
  },
  {
    id: 'suits',
    title: 'Suits and trump',
    blocks: [
      {
        kind: 'text',
        text: 'Each end of a domino is a suit, from blanks up to sixes, so most dominoes belong to two suits. The bidder names one suit as trump for the hand.',
      },
      {
        kind: 'list',
        items: [
          'A trump domino belongs only to trump. With sixes trump, the 6-4 is a six, never a four.',
          'Any other domino leads as its higher end: lead the 5-3 and fives are the suit led.',
          'A trump beats any domino of another suit, and a higher trump beats a lower one.',
        ],
      },
      {
        kind: 'dominoes',
        caption: 'With sixes trump, these seven are trump, highest first:',
        dominoes: [d(6, 6), d(6, 5), d(6, 4), d(6, 3), d(6, 2), d(6, 1), d(6, 0)],
      },
      {
        kind: 'text',
        text: 'Once the bid is 42 or more, the bidder may instead call Follow Me (no trump: the suit led is the only suit that wins) or Low (see Doubles and Scoring).',
      },
    ],
  },
  {
    id: 'doubles',
    title: 'Doubles',
    blocks: [
      {
        kind: 'text',
        text: 'A double belongs to just one suit - the 4-4 is a four - and it is the highest domino of that suit.',
      },
      {
        kind: 'dominoes',
        caption: 'Fours, highest to lowest:',
        dominoes: [d(4, 4), d(6, 4), d(5, 4), d(4, 3), d(4, 2), d(4, 1), d(4, 0)],
      },
      { kind: 'text', text: 'When the bidder calls Low, they also choose how doubles play for that hand:' },
      {
        kind: 'list',
        items: LOW_TRUMPS.map((suit) => `Doubles ${lowDoublesToPrettyString(suit)}: ${DOUBLES_DETAIL[suit]}.`),
      },
    ],
  },
  {
    id: 'bidding',
    title: 'Bidding',
    blocks: [
      {
        kind: 'text',
        text: 'Bidding goes once around the table. Each player bids or passes once, and every bid has to beat the high bid so far.',
      },
      {
        kind: 'list',
        items: [
          '30 to 42: the points your team will take this hand. Worth 1 mark.',
          '84: worth 2 marks, and your team must take all 42 points.',
          '3 Marks to 7 Marks: all 42 points again, one rung at a time - 3 Marks only over a standing 84, 4 Marks only over 3 Marks, and so on.',
          'Plunge: needs four or more doubles in your hand, and only while the high bid is under 4 Marks. Worth 4 marks: your partner names trump, and your team must take every trick.',
          'Pass: no bid this hand. Everyone can’t pass - if the first three do, the last player has to bid.',
        ],
      },
      {
        kind: 'text',
        text: 'The high bidder names trump (on a Plunge, their partner does), and whoever names trump leads the first trick.',
      },
    ],
  },
  {
    id: 'counting',
    title: 'Counting dominoes',
    blocks: [
      { kind: 'text', text: 'Every hand is worth 42 points. Five dominoes carry points - the counters:' },
      {
        kind: 'dominoes',
        caption: '10 points each: 5-5 and 6-4. 5 points each: 5-0, 4-1 and 3-2.',
        dominoes: [d(5, 5), d(6, 4), d(5, 0), d(4, 1), d(3, 2)],
      },
      {
        kind: 'text',
        text: 'That’s 35 points in counters, plus 1 point for each of the seven tricks: 42 in all. The counters in a trick go to the team that wins it.',
      },
      {
        kind: 'text',
        text: 'The hand ends as soon as it’s decided: once the bidders have the points they bid, or the other team has taken enough that they can’t.',
      },
    ],
  },
  {
    id: 'tricks',
    title: 'Playing tricks',
    blocks: [
      {
        kind: 'list',
        items: [
          'Whoever won the last trick leads the next.',
          'Follow the suit led if you can. If you can’t, play anything - including a trump.',
          'The highest trump in the trick wins it. With no trump in it, the highest domino of the suit led wins.',
          'On Low the bidder’s partner sits out, so each trick has three dominoes.',
        ],
      },
    ],
  },
  {
    id: 'scoring',
    title: 'Scoring',
    blocks: [
      {
        kind: 'list',
        items: [
          'Make your bid and your team scores its marks: 1 for 30 to 42, 2 for 84, and so on. A Plunge is worth 4.',
          'Set the bidders and your team scores those marks instead.',
          'Low is lost the moment the bidder takes a trick, and made if they take none.',
          `The first team to ${WINNING_SCORE} marks wins the match.`,
        ],
      },
    ],
  },
];

// Whether to offer the Lobby's "New to 42?" card: only when the profile says the player hasn't
// seen the rules. Strict, so a profile still loading - or from a worker that doesn't know the
// setting, where dismissing it couldn't be saved - offers nothing.
export function shouldOfferHowToPlay(profile: { seenHowToPlay?: boolean } | undefined): boolean {
  return profile?.seenHowToPlay === false;
}
```

  Add `export * from './howToPlay';` to `packages/client/src/index.ts` (alphabetical, after
  `./api`), and add "the How to play copy" to the index header's list.

- [ ] **Step 5: Run tests and typecheck.** `npm test -w @fortytwo/client && npm test -w @fortytwo/rules && npm run typecheck -w @fortytwo/client` → all PASS.

- [ ] **Step 6: Commit.**

```bash
git add packages/rules/src packages/client/src
git commit -m "feat(web): shared how to play copy in @fortytwo/client (#112)"
```

---

### Task 2: `seenHowToPlay` profile setting (api-types + worker)

**Files:**
- Modify: `packages/api-types/src/index.ts` (`user_metadata`, `UserProfile`, `ProfilePatch`)
- Modify: `apps/worker/src/requestBody.ts` (`profilePatch`)
- Modify: `apps/worker/src/users/profile.ts` (`toUserResponse` + header comment)
- Test: `apps/worker/test/routes.users.test.ts`

**Interfaces:**
- Produces: `UserProfile.seenHowToPlay: boolean`; `ProfilePatch.seenHowToPlay?: boolean`.
  `shouldOfferHowToPlay` keeps its `{ seenHowToPlay?: boolean } | undefined` parameter, which
  `UserProfile` satisfies.

- [ ] **Step 1: Write the failing tests** in `routes.users.test.ts`, beside the
  `highlightPlayable` cases:

```ts
    it('stores the seen-how-to-play setting', async () => {
      const seen = mockUserPatch();
      const res = await api('/api/users', 'auth0|p1', {
        method: 'PATCH',
        body: JSON.stringify({ seenHowToPlay: true }),
      });
      expect(res.status).toBe(200);
      expect(seen.body).toEqual({ user_metadata: { seenHowToPlay: true } });
    });
```

  add `['a non-boolean seen-how-to-play setting', { seenHowToPlay: 'yes' }],` to the `it.each`
  400 table, and next to `describe('highlightPlayable', ...)`:

```ts
  describe('seenHowToPlay', () => {
    it('is false until the player has seen the rules', () => {
      expect(toUserResponse({ user_id: 'u1' }).seenHowToPlay).toBe(false);
      expect(toUserResponse({ user_id: 'u1', user_metadata: { seenHowToPlay: true } }).seenHowToPlay).toBe(true);
    });

    it('is not shown to other players', () => {
      expect(toPublicUser({ user_id: 'u1', user_metadata: { seenHowToPlay: true } })).not.toHaveProperty('seenHowToPlay');
    });
  });
```

- [ ] **Step 2: Run them to see them fail.** `npm test -w @fortytwo/worker -- routes.users` → FAIL
  (type errors / undefined). Use Node 25 if vitest-pool-workers complains (`nvm use 25.7`).

- [ ] **Step 3: Implement.**
  - api-types: add `seenHowToPlay?: boolean;` to `user_metadata` and `ProfilePatch`; to
    `UserProfile` add
    ```ts
      // Whether they've dismissed the Lobby's "New to 42?" card or opened How to play. False until
      // they have.
      seenHowToPlay: boolean;
    ```
  - `requestBody.ts` `profilePatch`: `if (body.seenHowToPlay !== undefined) patch.seenHowToPlay = setting(body, 'seenHowToPlay');`
  - `profile.ts`: `seenHowToPlay: u.user_metadata?.seenHowToPlay === true,` in `toUserResponse`, and
    `//   seenHowToPlay: false until they've dismissed the card or opened the rules.` in the header.
  - Fix any fixtures typed `UserProfile` that now miss the field (`npm run typecheck` lists them;
    e.g. `apps/mobile/src/dev/devBypass.ts` gets `seenHowToPlay: true`).

- [ ] **Step 4: Run tests and typecheck.** `npm test -w @fortytwo/worker && npm run typecheck` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/api-types apps/worker apps/mobile/src/dev apps/web/src
git commit -m "feat(worker): remember whether a player has seen how to play (#112)"
```

---

### Task 3: One doubles wording in both trump pickers and the doubles modal

**Files:**
- Modify: `apps/web/src/components/TrumpPicker.tsx:16-20` (drop local `DOUBLES_DETAIL`, import from `@fortytwo/client`)
- Modify: `apps/mobile/src/components/TrumpPicker.tsx:11-15` (same)
- Modify: `apps/mobile/src/components/DoublesRuleModal.tsx:7` (`import { DOUBLES_DETAIL } from '@fortytwo/client';`)

**Interfaces:** Consumes `DOUBLES_DETAIL` from Task 1.

- [ ] **Step 1:** Delete each local `DOUBLES_DETAIL` and add `import { DOUBLES_DETAIL } from '@fortytwo/client';`. Remove now-unused `Suit` imports only if the typechecker says so.
- [ ] **Step 2:** `npm test -w @fortytwo/web && npm test -w @fortytwo/mobile && npm run typecheck` → PASS (web loses the "(this is how doubles normally behave)" suffix; no test asserts it).
- [ ] **Step 3: Commit.** `git commit -am "refactor(web): one doubles wording from @fortytwo/client (#112)"`

---

### Task 4: Web - page, nav link, in-match dialog, Lobby card

**Files:**
- Create: `apps/web/src/components/HowToPlayContent.tsx` + `HowToPlay.css`
- Create: `apps/web/src/components/HowToPlayDialog.tsx`
- Create: `apps/web/src/match/useHowToPlay.ts`
- Create: `apps/web/src/pages/HowToPlay.tsx`
- Create: `apps/web/src/pages/HowToPlay.test.tsx`
- Modify: `apps/web/src/main.tsx` (route `/how-to-play`), `components/NavBar.tsx` (link)
- Modify: `apps/web/src/pages/Lobby.tsx` (card) + `Lobby.test.tsx`
- Modify: `apps/web/src/pages/Match.tsx` (scoreboard "?" + dialog) + `Match.test.tsx`
- Modify: `apps/web/src/styles/match.css` (the "?" button)

**Interfaces:**
- Consumes: `HOW_TO_PLAY`, `shouldOfferHowToPlay` (Task 1); `seenHowToPlay` (Task 2).
- Produces: `useHowToPlay(client): { offer: boolean; markSeen: () => void }`;
  `HowToPlayContent(): JSX.Element`; `HowToPlayDialog({ open, onClose })`.

- [ ] **Step 1: `useHowToPlay`** (`apps/web/src/match/useHowToPlay.ts`):

```ts
// Whether to offer the Lobby's "New to 42?" card, and marking the rules seen (dismissing the card,
// or opening the rules page or dialog). Reads and updates the ['profile'] query shared with the
// profile and match pages; the card goes at once and comes back if the save fails.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { shouldOfferHowToPlay } from '@fortytwo/client';
import type { apiClient, UserProfile } from '../api/client';

export function useHowToPlay(client: ReturnType<typeof apiClient>): { offer: boolean; markSeen: () => void } {
  const queryClient = useQueryClient();
  const profileQuery = useQuery({ queryKey: ['profile'], queryFn: () => client.getProfile(), staleTime: Infinity });
  const offer = shouldOfferHowToPlay(profileQuery.data);
  const save = useMutation({
    mutationFn: () => client.patchProfile({ seenHowToPlay: true }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['profile'] });
      const previous = queryClient.getQueryData<UserProfile>(['profile']);
      if (previous) queryClient.setQueryData<UserProfile>(['profile'], { ...previous, seenHowToPlay: true });
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(['profile'], context.previous);
    },
  });
  // Only a profile that says "not seen" is worth a save: one that's loading, already seen, or from
  // a worker that doesn't know the setting is left alone.
  const markSeen = () => {
    if (offer && !save.isPending) save.mutate();
  };
  return { offer, markSeen };
}
```

- [ ] **Step 2: `HowToPlayContent`** (`components/HowToPlayContent.tsx`), rendering every section
  with an `id` for the index links:

```tsx
// The How to play copy (@fortytwo/client's HOW_TO_PLAY), for the rules page and the in-match
// dialog. Domino examples use the table's own Domino, standing upright in a row.
import type { JSX } from 'react';
import { HOW_TO_PLAY } from '@fortytwo/client';
import { Domino } from './Domino';
import './HowToPlay.css';

export function HowToPlayContent({ headingLevel = 2 }: { headingLevel?: 2 | 3 }): JSX.Element {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className="how-to-play">
      {HOW_TO_PLAY.map((section) => (
        <section key={section.id} id={`how-to-play-${section.id}`} aria-labelledby={`how-to-play-${section.id}-title`}>
          <Heading id={`how-to-play-${section.id}-title`}>{section.title}</Heading>
          {section.blocks.map((block, i) =>
            block.kind === 'text' ? (
              <p key={i}>{block.text}</p>
            ) : block.kind === 'list' ? (
              <ul key={i}>
                {block.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : (
              <figure key={i} className="how-to-play-dominoes">
                <div className="how-to-play-row" aria-hidden="true">
                  {block.dominoes.map((d) => (
                    <Domino key={`${d.top}-${d.bottom}`} top={d.top} bottom={d.bottom} direction="vertical" />
                  ))}
                </div>
                <figcaption>
                  {block.caption}{' '}
                  <span className="visually-hidden">{block.dominoes.map((d) => `${d.top}-${d.bottom}`).join(', ')}</span>
                </figcaption>
              </figure>
            )
          )}
        </section>
      ))}
    </div>
  );
}
```

  `HowToPlay.css`: `.how-to-play` max-width 42rem, section spacing; `.how-to-play-row` a wrapping
  flex row with `gap: .5rem`; `.visually-hidden` (if not already in app.css - grep first) as the
  standard clip pattern. Use the existing theme tokens from `styles/theme.css`.

- [ ] **Step 3: Page and dialog.**

`pages/HowToPlay.tsx`:

```tsx
// How to play: the rules of Forty-Two (@fortytwo/client's HOW_TO_PLAY) with an index of its
// sections. Opening it counts as having seen the rules, so the Lobby stops offering them.
import { useEffect } from 'react';
import type { JSX } from 'react';
import { HOW_TO_PLAY } from '@fortytwo/client';
import { apiClient } from '../api/client';
import { useGetToken } from '../auth/useGetToken';
import { HowToPlayContent } from '../components/HowToPlayContent';
import { useHowToPlay } from '../match/useHowToPlay';

export function HowToPlay(): JSX.Element {
  const { offer, markSeen } = useHowToPlay(apiClient(useGetToken()));
  useEffect(() => {
    if (offer) markSeen();
  }, [offer]); // eslint-disable-line react-hooks/exhaustive-deps -- once the profile says "not seen"
  return (
    <div className="how-to-play-page">
      <h1 className="page-title">How to play</h1>
      <nav aria-label="Sections" className="how-to-play-index">
        {HOW_TO_PLAY.map((s) => (
          <a key={s.id} href={`#how-to-play-${s.id}`}>
            {s.title}
          </a>
        ))}
      </nav>
      <HowToPlayContent />
    </div>
  );
}
```

`components/HowToPlayDialog.tsx`, using the MatchSummary dialog markup pattern:

```tsx
// The rules in a dialog over the table, from the scoreboard's "?" - so a player can check a rule
// without leaving their seat. Closes on ×, Escape or the backdrop.
import { useEffect } from 'react';
import type { JSX } from 'react';
import { HowToPlayContent } from './HowToPlayContent';

export function HowToPlayDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="how-to-play-backdrop" onClick={onClose}>
      <div
        className="how-to-play-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="how-to-play-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="how-to-play-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <h2 id="how-to-play-dialog-title">How to play</h2>
        <HowToPlayContent headingLevel={3} />
      </div>
    </div>
  );
}
```

  Dialog CSS in `HowToPlay.css`: fixed backdrop like `.match-summary-backdrop`, panel scrolls
  (`max-height: 90vh; overflow-y: auto`).

- [ ] **Step 4: Wire it up.**
  - `main.tsx`: `import { HowToPlay } from './pages/HowToPlay.tsx'` and
    `<Route path="/how-to-play" element={<HowToPlay />} />` before the `*` route.
  - `NavBar.tsx`: `<NavLink to="/how-to-play">How to play</NavLink>` between Lobby and Profile.
  - `Match.tsx`: `const howToPlay = useHowToPlay(client); const [rulesOpen, setRulesOpen] = useState(false);`
    In the `.contract` div, after the trump span:
    ```tsx
    <button
      type="button"
      className="contract-rules"
      aria-label="How to play"
      onClick={() => {
        setRulesOpen(true);
        howToPlay.markSeen();
      }}
    >
      ?
    </button>
    ```
    and `<HowToPlayDialog open={rulesOpen} onClose={() => setRulesOpen(false)} />` beside the
    MatchSummary. `match.css`: `.contract-rules` a small round brass-outlined button.
  - `Lobby.tsx`: `const howToPlay = useHowToPlay(client);` and between the header and the errors:
    ```tsx
    {howToPlay.offer && (
      <aside className="how-to-play-card" aria-label="New to Forty-Two">
        <Link to="/how-to-play">New to 42? Learn how to play</Link>
        <button type="button" aria-label="Dismiss" onClick={howToPlay.markSeen}>
          ×
        </button>
      </aside>
    )}
    ```
    `Lobby.css`: `.how-to-play-card` a bordered row like the existing panels, link left, × right.

- [ ] **Step 5: Tests.**

`pages/HowToPlay.test.tsx` (mock `../api/client` and `@auth0/auth0-react` the way `Lobby.test.tsx` does):

```tsx
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOW_TO_PLAY } from '@fortytwo/client';
import { HowToPlay } from './HowToPlay';

const { getProfileMock, patchProfileMock } = vi.hoisted(() => ({ getProfileMock: vi.fn(), patchProfileMock: vi.fn() }));
vi.mock('../api/client', () => ({ apiClient: () => ({ getProfile: getProfileMock, patchProfile: patchProfileMock }) }));
vi.mock('@auth0/auth0-react', () => ({ useAuth0: () => ({ getAccessTokenSilently: vi.fn(async () => 'test-token') }) }));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HowToPlay />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('HowToPlay page', () => {
  beforeEach(() => {
    patchProfileMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows every section, with an index linking to each', async () => {
    getProfileMock.mockResolvedValue({ user_id: 'p1', displayName: 'Me', seenHowToPlay: true });
    renderPage();
    for (const s of HOW_TO_PLAY) {
      expect(screen.getByRole('heading', { name: s.title })).toBeTruthy();
      expect(screen.getByRole('link', { name: s.title }).getAttribute('href')).toBe(`#how-to-play-${s.id}`);
    }
  });

  it('marks the rules seen once the profile says they were not', async () => {
    let resolve!: (p: unknown) => void;
    getProfileMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPage();
    // Still loading: nothing to save yet.
    expect(patchProfileMock).not.toHaveBeenCalled();
    resolve({ user_id: 'p1', displayName: 'Me', seenHowToPlay: false });
    await waitFor(() => expect(patchProfileMock).toHaveBeenCalledWith({ seenHowToPlay: true }));
  });

  it('saves nothing when already seen, or when the worker does not know the setting', async () => {
    getProfileMock.mockResolvedValue({ user_id: 'p1', displayName: 'Me', seenHowToPlay: true });
    renderPage();
    await waitFor(() => expect(getProfileMock).toHaveBeenCalled());
    cleanup();
    getProfileMock.mockResolvedValue({ user_id: 'p1', displayName: 'Me' });
    renderPage();
    await waitFor(() => expect(getProfileMock).toHaveBeenCalledTimes(2));
    expect(patchProfileMock).not.toHaveBeenCalled();
  });
});
```

`Lobby.test.tsx`: add `getProfileMock`, `patchProfileMock` to the hoisted mocks and the
`apiClient` mock; in the existing `beforeEach` default `getProfileMock.mockResolvedValue({ user_id: 'me', displayName: 'Me', seenHowToPlay: true })`. New `describe('How to play card')`:

```tsx
  it('offers the rules to a player who has not seen them', async () => {
    getProfileMock.mockResolvedValue({ user_id: 'me', displayName: 'Me', seenHowToPlay: false });
    renderLobby();
    const card = await screen.findByRole('complementary', { name: 'New to Forty-Two' });
    expect(within(card).getByRole('link', { name: 'New to 42? Learn how to play' }).getAttribute('href')).toBe('/how-to-play');
  });

  it('hides the card when seen, or when the profile has no setting', async () => {
    renderLobby();
    await waitFor(() => expect(getProfileMock).toHaveBeenCalled());
    expect(screen.queryByRole('complementary', { name: 'New to Forty-Two' })).toBeNull();
  });

  it('dismisses the card at once and saves it', async () => {
    getProfileMock.mockResolvedValue({ user_id: 'me', displayName: 'Me', seenHowToPlay: false });
    patchProfileMock.mockResolvedValue(undefined);
    renderLobby();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('complementary', { name: 'New to Forty-Two' })).toBeNull();
    expect(patchProfileMock).toHaveBeenCalledWith({ seenHowToPlay: true });
  });

  it('brings the card back if the save fails', async () => {
    getProfileMock.mockResolvedValue({ user_id: 'me', displayName: 'Me', seenHowToPlay: false });
    patchProfileMock.mockRejectedValue(new Error('offline'));
    renderLobby();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByRole('complementary', { name: 'New to Forty-Two' })).toBeTruthy();
  });
```

  (`renderLobby` = whatever helper `Lobby.test.tsx` already uses to render; reuse it. The
  "no setting" case is the default `seenHowToPlay: true` plus one run with `{ user_id, displayName }`
  only - add both via `it.each` if the helper makes that tidy.)

`Match.test.tsx`: in a seated, in-progress match test setup, add `patchProfileMock` handling if
not present, then:

```tsx
  it('opens the rules over the table from the scoreboard, and closes them', async () => {
    // ...existing render helper for a seated match...
    fireEvent.click(await screen.findByRole('button', { name: 'How to play' }));
    const dialog = screen.getByRole('dialog', { name: 'How to play' });
    expect(within(dialog).getByRole('heading', { name: 'Bidding' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'How to play' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'How to play' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'How to play' })).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'How to play' })).toBeNull();
  });
```

  NavBar: if a NavBar test exists add `getByRole('link', { name: 'How to play' })` → `/how-to-play`;
  otherwise add the assertion to `HowToPlay.test.tsx` by rendering `<NavBar />` in a `MemoryRouter`.

- [ ] **Step 6: Run.** `npm test -w @fortytwo/web && npm run typecheck -w @fortytwo/web && npm run lint -w @fortytwo/web` → PASS. Then `npm run dev -w @fortytwo/web` and look at `/how-to-play`, the Lobby card, and the match "?" dialog in both themes (the `run` skill covers launching).

- [ ] **Step 7: Commit.** `git add apps/web && git commit -m "feat(web): how to play page, nav link, match dialog and lobby card (#112)"`

---

### Task 5: Mobile - screen, header buttons, Lobby card

**Files:**
- Create: `apps/mobile/src/components/HowToPlayContent.tsx`
- Create: `apps/mobile/src/components/HowToPlayCard.tsx`
- Create: `apps/mobile/src/components/HelpButton.tsx`
- Create: `apps/mobile/src/api/useHowToPlay.ts`
- Create: `apps/mobile/src/app/how-to-play.tsx`
- Modify: `apps/mobile/src/app/_layout.tsx` (register screen), `app/index.tsx` (header "?" + card), `app/match/[id].tsx` (`headerRight`)
- Test: `apps/mobile/src/components/__tests__/components.test.tsx`

**Interfaces:**
- Consumes: `HOW_TO_PLAY`, `shouldOfferHowToPlay` (Task 1); `useProfile`, `useSaveProfile` (`src/api/useProfile.ts`).
- Produces: `useHowToPlay(): { offer: boolean; markSeen: () => void }`;
  `HowToPlayContent()`, `HowToPlayCard({ onOpen, onDismiss })`, `HelpButton({ onPress })`.

- [ ] **Step 1: Write the failing component tests** (append to `components.test.tsx`):

```tsx
import { HOW_TO_PLAY } from '@fortytwo/client';
import { HelpButton } from '../HelpButton';
import { HowToPlayCard } from '../HowToPlayCard';
import { HowToPlayContent } from '../HowToPlayContent';

describe('HowToPlayContent', () => {
  it('shows every section and its domino examples', async () => {
    await render(<HowToPlayContent />);
    for (const s of HOW_TO_PLAY) expect(screen.getByRole('header', { name: s.title })).toBeTruthy();
    expect(screen.getByLabelText(/10 points each.*5-5, 6-4, 5-0, 4-1, 3-2/)).toBeTruthy();
  });
});

describe('HowToPlayCard', () => {
  it('opens the rules or dismisses itself', async () => {
    const onOpen = jest.fn();
    const onDismiss = jest.fn();
    await render(<HowToPlayCard onOpen={onOpen} onDismiss={onDismiss} />);
    fireEvent.press(screen.getByRole('button', { name: 'New to 42? Learn how to play' }));
    expect(onOpen).toHaveBeenCalled();
    fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('HelpButton', () => {
  it('is a labelled button', async () => {
    const onPress = jest.fn();
    await render(<HelpButton onPress={onPress} />);
    fireEvent.press(screen.getByRole('button', { name: 'How to play' }));
    expect(onPress).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to see them fail.** `npm test -w @fortytwo/mobile -- components` → FAIL (modules missing).

- [ ] **Step 3: Implement the components.**

`HowToPlayContent.tsx`:

```tsx
// The How to play copy (@fortytwo/client's HOW_TO_PLAY) for the rules screen. Domino examples use
// the table's Domino, upright in a wrapping row, read out as one label with their caption.
import { StyleSheet, Text, View } from 'react-native';
import { HOW_TO_PLAY } from '@fortytwo/client';
import { Domino } from './Domino';
import { colors, fonts } from './theme';

export function HowToPlayContent() {
  return (
    <View style={styles.content}>
      {HOW_TO_PLAY.map((section) => (
        <View key={section.id} style={styles.section}>
          <Text style={styles.title} accessibilityRole="header">
            {section.title}
          </Text>
          {section.blocks.map((block, i) =>
            block.kind === 'text' ? (
              <Text key={i} style={styles.text}>
                {block.text}
              </Text>
            ) : block.kind === 'list' ? (
              <View key={i} style={styles.list}>
                {block.items.map((item) => (
                  <Text key={item} style={styles.text}>
                    {'•  '}
                    {item}
                  </Text>
                ))}
              </View>
            ) : (
              <View
                key={i}
                style={styles.figure}
                accessible
                accessibilityLabel={`${block.caption} ${block.dominoes.map((d) => `${d.top}-${d.bottom}`).join(', ')}`}
              >
                <View style={styles.row}>
                  {block.dominoes.map((d) => (
                    <Domino key={`${d.top}-${d.bottom}`} top={d.top} bottom={d.bottom} width={28} accessible={false} />
                  ))}
                </View>
                <Text style={styles.caption}>{block.caption}</Text>
              </View>
            )
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: 24 },
  section: { gap: 10 },
  title: { color: colors.bone, fontFamily: fonts.display, fontSize: 22 },
  text: { color: colors.bone, fontFamily: fonts.ui, fontSize: 16, lineHeight: 23 },
  list: { gap: 6 },
  figure: { gap: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  caption: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 14, opacity: 0.8 },
});
```

  (Check `theme.ts` for the exact `colors` / `fonts` keys - `bone`, `brass`, `walnut`,
  `walnutDeep`, `fonts.ui`, `fonts.uiBold`, `fonts.display` are used by `DoublesRuleModal`.)

`HowToPlayCard.tsx`:

```tsx
// The Lobby's "New to 42?" card, offered until the player dismisses it or opens the rules.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from './theme';

export function HowToPlayCard({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return (
    <View style={styles.card}>
      <Pressable style={styles.open} onPress={onOpen} accessibilityRole="button">
        <Text style={styles.text}>New to 42? Learn how to play</Text>
      </Pressable>
      <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel="Dismiss" hitSlop={12}>
        <Text style={styles.close}>×</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.brass,
    backgroundColor: colors.walnutDeep,
  },
  open: { flex: 1 },
  text: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 16 },
  close: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 24, lineHeight: 24 },
});
```

`HelpButton.tsx`:

```tsx
// A round "?" opening How to play, for the Lobby header and the match screen's header.
import { Pressable, StyleSheet, Text } from 'react-native';
import { colors, fonts } from './theme';

export function HelpButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="How to play"
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Text style={styles.text}>?</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: colors.brass,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
  text: { color: colors.bone, fontFamily: fonts.uiBold, fontSize: 17 },
});
```

- [ ] **Step 4: Run the component tests.** `npm test -w @fortytwo/mobile -- components` → PASS.

- [ ] **Step 5: Hook, screen and wiring.**

`api/useHowToPlay.ts`:

```ts
// Whether to offer the Lobby's "New to 42?" card, and marking the rules seen (dismissing the card
// or opening the rules screen). Saved to the profile, so it holds on web too; useSaveProfile shows
// the change at once and puts it back if the save fails.
import { shouldOfferHowToPlay } from '@fortytwo/client';
import { useProfile, useSaveProfile } from './useProfile';

export function useHowToPlay(): { offer: boolean; markSeen: () => void } {
  const profile = useProfile();
  const save = useSaveProfile();
  const offer = shouldOfferHowToPlay(profile.data);
  const markSeen = () => {
    if (offer && !save.isPending) save.mutate({ seenHowToPlay: true });
  };
  return { offer, markSeen };
}
```

`app/how-to-play.tsx`:

```tsx
// How to play: the rules of Forty-Two. Opening it counts as having seen them, so the Lobby stops
// offering them.
import { useEffect } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHowToPlay } from '@/api/useHowToPlay';
import { HowToPlayContent } from '@/components/HowToPlayContent';
import { colors } from '@/components/theme';

export default function HowToPlayScreen() {
  const { offer, markSeen } = useHowToPlay();
  const { bottom } = useSafeAreaInsets();
  useEffect(() => {
    if (offer) markSeen();
    // Once the profile says "not seen".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer]);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 20, paddingBottom: 32 + bottom }}>
      <HowToPlayContent />
    </ScrollView>
  );
}

const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: colors.walnut } });
```

  - `_layout.tsx`: `<Stack.Screen name="how-to-play" options={{ title: 'How to play' }} />` inside
    the signed-in `Stack.Protected`.
  - `app/index.tsx`: in `titleRow`, wrap `<ProfileButton />` with
    `<View style={styles.headerButtons}><HelpButton onPress={() => router.push('/how-to-play')} /><ProfileButton /></View>`
    (`headerButtons: { flexDirection: 'row', alignItems: 'center', gap: 12 }`); and below the
    header `View`:
    ```tsx
    {howToPlay.offer && (
      <View style={styles.cardWrap}>
        <HowToPlayCard onOpen={() => router.push('/how-to-play')} onDismiss={howToPlay.markSeen} />
      </View>
    )}
    ```
    with `const howToPlay = useHowToPlay();` at the top of the component and
    `cardWrap: { paddingHorizontal: 16, paddingTop: 12 }` (match the list's horizontal padding).
  - `app/match/[id].tsx`: both `<Stack.Screen options={{ title: ... }} />` get
    `headerRight: () => <HelpButton onPress={() => router.push('/how-to-play')} />`. Define it once
    as `const helpHeader = () => <HelpButton onPress={() => router.push('/how-to-play')} />;` at
    module level and reuse it.

- [ ] **Step 6: Run.** `npm test -w @fortytwo/mobile && npm run typecheck -w @fortytwo/mobile` → PASS.

- [ ] **Step 7: Emulator check** (mobile-emulator skill): Lobby "?" and card appear (dev bypass
  profile has `seenHowToPlay: true`, so temporarily flip it to `false` locally to see the card -
  don't commit that); the rules screen scrolls through every section with dominoes; from a dev
  match, "?" opens the rules and back returns to the same match. Screenshot each.

- [ ] **Step 8: Commit.** `git add apps/mobile && git commit -m "feat(mobile): how to play screen, header buttons and lobby card (#112)"`

---

### Task 6: Full check and PR

- [ ] **Step 1:** From `cloudflare/`: `npm test && npm run typecheck && npm run lint` → all PASS (worker tests on Node 25 if needed).
- [ ] **Step 2:** Push with `git -c http.sslBackend=schannel push -u origin waterfausett/how-to-play`.
- [ ] **Step 3:** `gh pr create --base master --title "feat(web): how to play rules screen" --body` with a summary (shared copy, seen setting, web, mobile), the screenshots, a test plan, `Closes #112`, and the Claude Code footer. Do not merge.
