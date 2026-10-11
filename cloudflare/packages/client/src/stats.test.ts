import { describe, it, expect } from 'vitest';
import type { StatsSummary } from '@fortytwo/api-types';
import { bestPartnerRecord, statTiles, STATS_FILTERS } from './stats';

const EMPTY: StatsSummary = {
  played: 0, won: 0, lost: 0, marksWon: 0, bidsWon: 0, bidsMade: 0, bidsSet: 0,
  averagePointsBid: null, marksBids: 0, bestPartner: null,
};

describe('statTiles', () => {
  it('shows rates and the average as a dash when there is nothing to divide', () => {
    const values = Object.fromEntries(statTiles(EMPTY).map((t) => [t.label, t.value]));
    expect(values).toEqual({
      Played: '0', Won: '0', Lost: '0', 'Win rate': '–', 'Marks won': '0',
      'Bids won': '0', Made: '0', Set: '0', 'Made rate': '–', 'Avg. points bid': '–', 'Marks bids': '0',
    });
  });

  it('rounds rates to whole percents and keeps one decimal on the average', () => {
    const values = Object.fromEntries(
      statTiles({ ...EMPTY, played: 3, won: 2, lost: 1, bidsWon: 3, bidsMade: 1, bidsSet: 2, averagePointsBid: 31.5 }).map(
        (t) => [t.label, t.value]
      )
    );
    expect(values['Win rate']).toBe('67%');
    expect(values['Made rate']).toBe('33%');
    expect(values['Avg. points bid']).toBe('31.5');
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
