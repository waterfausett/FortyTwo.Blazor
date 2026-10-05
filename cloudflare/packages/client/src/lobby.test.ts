import { describe, expect, it } from 'vitest';
import type { MatchSummary } from '@fortytwo/api-types';
import { uniqueMatches } from './lobby';

const row = (id: string) => ({ id }) as MatchSummary;

describe('uniqueMatches', () => {
  it('is undefined before the first page loads', () => {
    expect(uniqueMatches(undefined)).toBeUndefined();
  });

  it('joins the pages in order and keeps only the first copy of a match', () => {
    const pages = [
      { matches: [row('a'), row('b')], nextCursor: 'c1' },
      { matches: [row('b'), row('c')], nextCursor: null },
    ];
    expect(uniqueMatches(pages)?.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});
