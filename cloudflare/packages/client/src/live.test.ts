import { describe, expect, it } from 'vitest';
import { LIVE_FILL_MS, LIVE_TURN_MS, createDomino, createMatch, takeSeat, type Domino, type MatchState } from '@fortytwo/rules';
import { formatClock, searchState, turnClock } from './live';

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}
function dealt(mode: 'live' | 'daily'): MatchState {
  let match = createMatch('p1', mode);
  match = takeSeat(match, 'p2', 1);
  match = takeSeat(match, 'p3', 2);
  return takeSeat(match, 'p4', 3, deck());
}

describe('searchState', () => {
  it('counts a Live search up from when it began', () => {
    const match = createMatch('p1', 'live');
    const now = Date.parse(match.searchStartedOn!) + 23_000;
    expect(searchState(match, now)).toEqual({ mode: 'live', elapsedMs: 23_000 });
  });

  it('says a Daily table is still looking, and nothing for a custom one or a dealt one', () => {
    expect(searchState(createMatch('p1', 'daily'), Date.now())).toEqual({ mode: 'daily' });
    expect(searchState(createMatch('p1'), Date.now())).toBeNull();
    expect(searchState(dealt('live'), Date.now())).toBeNull();
  });
});

describe('turnClock', () => {
  it('counts the Live turn down, never below zero', () => {
    const match = dealt('live');
    const start = Date.parse(match.updatedOn);
    expect(turnClock(match, start + 10_000)).toEqual({ playerIds: ['p1'], remainingMs: LIVE_TURN_MS - 10_000 });
    expect(turnClock(match, start + LIVE_TURN_MS * 2)!.remainingMs).toBe(0);
  });

  it('has no clock outside Live, or while filling', () => {
    expect(turnClock(dealt('daily'), Date.now())).toBeNull();
    expect(turnClock(createMatch('p1', 'live'), Date.now() + LIVE_FILL_MS)).toBeNull();
  });
});

describe('formatClock', () => {
  it('reads as m:ss, rounding seconds up so a countdown never shows 0:00 early', () => {
    expect(formatClock(23_000)).toBe('0:23');
    expect(formatClock(59_100)).toBe('1:00');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(125_000)).toBe('2:05');
  });
});
