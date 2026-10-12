import { describe, it, expect } from 'vitest';
import type { StatsSummary } from '@fortytwo/api-types';
import { bestPartnerRecord, favoriteTrumpRecord, statSections, STATS_FILTERS, trumpLabel } from './stats';

const EMPTY: StatsSummary = {
  played: 0, won: 0, lost: 0, marksWon: 0, bidsWon: 0, bidsMade: 0, bidsSet: 0,
  averagePointsBid: null, marksBids: 0, favoriteTrump: null, bestPartner: null,
};

// Each section's tiles as label -> value.
function sectionValues(s: StatsSummary): Record<string, Record<string, string>> {
  return Object.fromEntries(statSections(s).map((section) => [section.title, Object.fromEntries(section.tiles.map((t) => [t.label, t.value]))]));
}

describe('statSections', () => {
  it('groups match figures apart from bidding, with a dash where there is nothing to divide', () => {
    expect(statSections(EMPTY).map((section) => section.key)).toEqual(['matches', 'bidding']);
    expect(sectionValues(EMPTY)).toEqual({
      Matches: { Played: '0', Won: '0', Lost: '0', 'Win rate': '–', 'Marks won': '0' },
      Bidding: { 'Bids won': '0', Made: '0', Set: '0', 'Made rate': '–', 'Avg. points bid': '–', 'Bids of 42+': '–' },
    });
  });

  it('rounds rates to whole percents and keeps one decimal on the average', () => {
    const sections = sectionValues({ ...EMPTY, played: 3, won: 2, lost: 1, bidsWon: 3, bidsMade: 1, bidsSet: 2, averagePointsBid: 31.5, marksBids: 2 });
    const values = { ...sections.Matches, ...sections.Bidding };
    expect(values['Win rate']).toBe('67%');
    expect(values['Made rate']).toBe('33%');
    expect(values['Avg. points bid']).toBe('31.5');
    expect(values['Bids of 42+']).toBe('67%');
  });
});

describe('favorite trump', () => {
  it('names each trump as the table does', () => {
    expect(['low', 'followMe', 'blanks', 'aces', 'deuces', 'threes', 'fours', 'fives', 'sixes'].map((t) => trumpLabel(t as never))).toEqual([
      'Low', 'Follow Me', 'Blanks', 'Aces', 'Deuces', 'Threes', 'Fours', 'Fives', 'Sixes',
    ]);
  });

  it('reads as how many of their winning bids named it', () => {
    expect(favoriteTrumpRecord({ trump: 'sixes', times: 12 }, 41)).toBe('12 of 41 bids');
  });
});

describe('bestPartnerRecord', () => {
  it('reads as wins and losses together', () => {
    expect(bestPartnerRecord({ user: { user_id: 'u', displayName: 'Sam' }, won: 7, lost: 2 })).toBe('7–2 together');
  });
});

describe('STATS_FILTERS', () => {
  it('lists the three filters in order', () => {
    expect(STATS_FILTERS.map((f) => f.label)).toEqual(['All', 'Humans only', 'With bots']);
  });
});
