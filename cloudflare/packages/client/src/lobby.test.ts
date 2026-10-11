import { describe, expect, it } from 'vitest';
import type { MatchSummary } from '@fortytwo/api-types';
import { rowStatus, uniqueMatches, yourTurnFirst } from './lobby';

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

const summary = (overrides: Partial<MatchSummary>): MatchSummary => ({
  id: 'm',
  status: 'active',
  playerCount: 4,
  updatedOn: '2026-01-01T00:00:00Z',
  teams: [[], []],
  seats: [null, null, null, null],
  mode: 'daily',
  ...overrides,
});

describe('rowStatus', () => {
  it('reads each state the way the lobby shows it', () => {
    expect(rowStatus(summary({ status: 'completed' }))).toEqual({ text: 'Finished', yours: false });
    expect(rowStatus(summary({ playerCount: 2 }))).toEqual({ text: 'Looking for players · 2 of 4', yours: false });
    expect(rowStatus(summary({ turn: { kind: 'turn', yours: true, waitingOn: ['Me'] } }))).toEqual({ text: 'Your turn', yours: true });
    expect(rowStatus(summary({ turn: { kind: 'ready', yours: true, waitingOn: ['Me', 'Eli'] } }))).toEqual({ text: 'Ready up', yours: true });
    expect(rowStatus(summary({ turn: { kind: 'turn', yours: false, waitingOn: ['Eli'] } }))).toEqual({ text: "Eli's turn", yours: false });
    expect(rowStatus(summary({ turn: { kind: 'ready', yours: false, waitingOn: ['Eli'] } }))).toEqual({ text: 'Waiting for others to ready up', yours: false });
    expect(rowStatus(summary({ turn: null }))).toEqual({ text: 'In play', yours: false });
  });
});

describe('yourTurnFirst', () => {
  it('moves your-turn rows to the top and keeps the rest in order', () => {
    const rows = [
      summary({ id: 'a' }),
      summary({ id: 'b', turn: { kind: 'turn', yours: true, waitingOn: ['Me'] } }),
      summary({ id: 'c' }),
    ];
    expect(yourTurnFirst(rows).map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });
});
