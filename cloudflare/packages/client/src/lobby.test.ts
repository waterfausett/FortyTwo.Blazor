import { describe, expect, it } from 'vitest';
import type { MatchSummary } from '@fortytwo/api-types';
import { invitableTables, MODE_LABELS, rowStatus, tableDetail, tableTitle, uniqueMatches, yourTurnFirst } from './lobby';

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

describe('MODE_LABELS', () => {
  it('calls the matchmade modes Live Play and Async, and a bots match vs Bots', () => {
    expect(MODE_LABELS).toEqual({ live: 'Live Play', daily: 'Async', custom: 'Custom', bots: 'vs Bots' });
  });
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

describe('invitableTables', () => {
  const open = summary({ id: 'open', mode: 'custom', playerCount: 2, seats: ['Me', null, 'Ann', null] });
  it('keeps active Custom tables with a seat open that the person is not at', () => {
    const rows = [
      open,
      summary({ id: 'full', mode: 'custom', playerCount: 4, seats: ['Me', 'Bo', 'Cy', 'Di'] }),
      summary({ id: 'async', mode: 'daily', playerCount: 2, seats: ['Me', null, 'Bo', null] }),
      summary({ id: 'over', mode: 'custom', status: 'completed', playerCount: 2, seats: ['Me', null, 'Bo', null] }),
      summary({ id: 'seated', mode: 'custom', playerCount: 3, seats: ['Me', 'Bo', 'Cy', null] }),
    ];
    expect(invitableTables(rows, 'Bo').map((m) => m.id)).toEqual(['open']);
  });
});

describe('tableTitle and tableDetail', () => {
  it('name the teams, an empty one as Open seats, over how many seats are open', () => {
    const table = summary({ playerCount: 2, teams: [['Me', 'Ann'], []] });
    expect(tableTitle(table)).toBe('Me & Ann vs Open seats');
    expect(tableDetail(table)).toBe('2 seats open');
    expect(tableDetail(summary({ playerCount: 3 }))).toBe('1 seat open');
  });
});
