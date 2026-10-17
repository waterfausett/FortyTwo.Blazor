import { describe, expect, it } from 'vitest';
import type { StatsSummary } from '@fortytwo/api-types';
import { LIVE_FILL_MS, createDomino, dominoValue, type MatchPlayerRef } from '@fortytwo/rules';
import { SEARCH_TIPS, fillProgress, joinAnnouncement, lobbyCards, lobbyRoster, rosterIds, shuffledTips } from './searchLobby';
import { statSections } from './stats';

// The dev bypass's `all` summary (apps/mobile/src/dev/devBypass.ts).
const STATS: StatsSummary = {
  played: 23,
  won: 14,
  lost: 9,
  marksWon: 131,
  bidsWon: 41,
  bidsMade: 30,
  bidsSet: 11,
  averagePointsBid: 32.4,
  marksBids: 9,
  favoriteTrump: { trump: 'sixes', times: 12 },
  bestPartner: { user: { user_id: 'gj', displayName: 'Grandma Jo' }, won: 7, lost: 2 },
};
const rateAsProfileShowsIt = statSections(STATS)
  .flatMap((s) => s.tiles)
  .find((t) => t.label === 'Made rate')!.value;

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
  it('puts the viewer and the seat across in Us, the seats beside in Them, empty ones as null', () => {
    expect(lobbyRoster([seat('a', 0), seat('me', 2)], 'me')).toEqual({ us: ['me', 'a'], them: [null, null], seated: true });
    expect(lobbyRoster([seat('me', 1), seat('b', 2)], 'me')).toEqual({ us: ['me', null], them: ['b', null], seated: true });
    expect(lobbyRoster([seat('me', 3), seat('c', 0)], 'me')).toEqual({ us: ['me', null], them: ['c', null], seated: true });
  });
  it('uses seats 0 and 2 as Us for a viewer without a seat', () => {
    expect(lobbyRoster([seat('a', 1)], 'stranger')).toEqual({ us: [null, null], them: ['a', null], seated: false });
  });
  it('flattens to Us then Them for the announcements', () => {
    expect(rosterIds({ us: ['me', null], them: ['b', null], seated: true })).toEqual(['me', null, 'b', null]);
  });
});

describe('lobbyCards', () => {
  const tips = ['t1', 't2', 't3', 't4'];
  it('is tips only without stats, or with none played', () => {
    expect(lobbyCards(undefined, tips)).toEqual(tips.map((text) => ({ kind: 'tip', text })));
    expect(lobbyCards(null, tips)).toEqual(tips.map((text) => ({ kind: 'tip', text })));
    expect(lobbyCards({ ...STATS, played: 0 }, tips).every((c) => c.kind === 'tip')).toBe(true);
  });
  it('starts on a tip, then the summary, alternating stats pages with tips', () => {
    expect(lobbyCards(STATS, tips).map((c) => c.kind)).toEqual(['tip', 'summary', 'tip', 'favoriteTrump', 'tip', 'bestPartner', 'tip']);
  });
  it('uses the profile labels and formatting', () => {
    const cards = lobbyCards(STATS, tips);
    expect(cards[1]).toEqual({
      kind: 'summary',
      items: [
        { label: 'Played', value: '23' },
        { label: 'Won', value: '14' },
        { label: 'Made rate', value: rateAsProfileShowsIt },
      ],
    });
    expect(cards[3]).toEqual({ kind: 'favoriteTrump', trump: 'Sixes', record: '12 of 41 bids' });
    expect(cards[5]).toEqual({ kind: 'bestPartner', name: 'Grandma Jo', record: '7–2 together' });
  });
  it('leaves out favorite trump and best partner when there are none', () => {
    expect(lobbyCards({ ...STATS, favoriteTrump: null, bestPartner: null }, tips).map((c) => c.kind)).toEqual([
      'tip',
      'summary',
      'tip',
      'tip',
      'tip',
    ]);
  });
  it('uses the search tips by default', () => {
    expect(lobbyCards(undefined)).toEqual(SEARCH_TIPS.map((text) => ({ kind: 'tip', text })));
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

describe('shuffledTips', () => {
  it('has every tip once, in an order that depends on the random numbers', () => {
    const always = (n: number) => () => n;
    const low = shuffledTips(always(0));
    const high = shuffledTips(always(0.999));
    expect([...low].sort()).toEqual([...SEARCH_TIPS].sort());
    expect([...high].sort()).toEqual([...SEARCH_TIPS].sort());
    expect(low).not.toEqual(high);
  });
  it('leaves SEARCH_TIPS as written', () => {
    const before = [...SEARCH_TIPS];
    shuffledTips(() => 0);
    expect(SEARCH_TIPS).toEqual(before);
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
  it('counts the points the way the rules do', () => {
    const all = [];
    for (let a = 0; a <= 6; a++) for (let b = a; b <= 6; b++) all.push(createDomino(a, b));
    const countPoints = all.reduce((sum, d) => sum + dominoValue(d), 0);
    expect(SEARCH_TIPS[0]).toContain(`${countPoints + 7} points: ${countPoints} in the count`);
    expect(dominoValue(createDomino(5, 5))).toBe(10);
    expect(dominoValue(createDomino(6, 4))).toBe(10);
    for (const [a, b] of [[5, 0], [4, 1], [3, 2]]) expect(dominoValue(createDomino(a, b))).toBe(5);
    const counters = all.filter((d) => dominoValue(d) > 0).map((d) => `${d.bottom}-${d.top}`);
    expect(counters.sort()).toEqual(['3-2', '4-1', '5-0', '5-5', '6-4']);
    for (const c of counters) expect(SEARCH_TIPS[1]).toContain(c);
  });
});
