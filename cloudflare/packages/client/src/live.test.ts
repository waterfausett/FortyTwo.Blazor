import { describe, expect, it } from 'vitest';
import { Bid, LIVE_FILL_MS, LIVE_TURN_MS, Suit, Teams, createDomino, createMatch, takeSeat, type Domino, type MatchState } from '@fortytwo/rules';
import { formatClock, nextHandClock, searchState, seatChanges, turnClock, viewerRole, watchAnchor } from './live';

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
function dealtLive(): MatchState {
  return dealt('live');
}
// p1 alone with the three bots, dealt, p1 to act.
function soloWithBots(): MatchState {
  let match = createMatch('p1', 'live');
  match = takeSeat(match, 'bot-1', 1);
  match = takeSeat(match, 'bot-2', 2);
  return takeSeat(match, 'bot-3', 3, deck());
}

// The hand decided - seat 1's team set seat 0's 30 bid - with `readied` ready for the next.
function atBreak(readied: string[]): MatchState {
  const match = dealtLive();
  const counts = [createDomino(5, 5), createDomino(6, 4), createDomino(5, 0), createDomino(4, 1)];
  return {
    ...match,
    players: match.players.map((p) => ({ ...p, ready: readied.includes(p.playerId) })),
    currentGame: {
      ...match.currentGame,
      biddingPlayerId: 'p1',
      bid: Bid.Thirty,
      trump: Suit.Sixes,
      tricks: [{ playerId: 'p2', team: Teams.TeamB, suit: Suit.Sixes, dominoes: counts }],
    },
  };
}

describe('searchState', () => {
  it('counts a Live search up from when it began', () => {
    const match = createMatch('p1', 'live');
    const now = Date.parse(match.searchStartedOn!) + 23_000;
    expect(searchState(match, now)).toEqual({ mode: 'live', elapsedMs: 23_000 });
  });

  it('says an Async table is still looking, and nothing for a custom one or a dealt one', () => {
    expect(searchState(createMatch('p1', 'daily'), Date.now())).toEqual({ mode: 'daily' });
    expect(searchState(createMatch('p1'), Date.now())).toBeNull();
    expect(searchState(dealt('live'), Date.now())).toBeNull();
  });
});

describe('turnClock', () => {
  it('counts the Live turn down, never below zero', () => {
    const match = dealt('live');
    const start = Date.parse(match.updatedOn);
    expect(turnClock(match, start + 10_000)).toEqual({ playerIds: ['p1'], remainingMs: LIVE_TURN_MS - 10_000, paused: false });
    expect(turnClock(match, start + LIVE_TURN_MS * 2)!.remainingMs).toBe(0);
  });

  it('has no clock outside Live, or while filling', () => {
    expect(turnClock(dealt('daily'), Date.now())).toBeNull();
    expect(turnClock(createMatch('p1', 'live'), Date.now() + LIVE_FILL_MS)).toBeNull();
  });
});

describe('viewerRole', () => {
  it('tells a seated player, a claimant, a bumped claimant, a replaced player and a stranger apart', () => {
    const match = { ...dealtLive(), claims: ['c'], bumped: ['b'], replaced: ['r'] };
    expect(viewerRole(match, 'p1')).toBe('seated');
    expect(viewerRole(match, 'c')).toBe('claiming');
    expect(viewerRole(match, 'b')).toBe('bumped');
    expect(viewerRole(match, 'r')).toBe('replaced');
    expect(viewerRole(match, 'x')).toBe('stranger');
  });
});

describe('watchAnchor', () => {
  it('views the table from the lowest seat, not the last one taken', () => {
    const match = dealtLive();
    const reversed = { ...match, players: [...match.players].reverse() };
    expect(watchAnchor(reversed)).toBe('p1');
  });
});

describe('seatChanges', () => {
  it('lists seats that changed hands', () => {
    const previous = dealtLive();
    const next = { ...previous, players: previous.players.map((p) => (p.position === 1 ? { ...p, playerId: 'n1' } : p)) };
    expect(seatChanges(previous, next)).toEqual([{ position: 1, from: previous.players.find((p) => p.position === 1)!.playerId, to: 'n1' }]);
    expect(seatChanges(previous, previous)).toEqual([]);
  });
});

describe('the clocks at the hand break', () => {
  it('puts no clock on the seats: nobody is taking a turn', () => {
    const match = atBreak(['p4']);
    expect(turnClock(match, Date.parse(match.updatedOn) + 10_000)).toBeNull();
  });

  it('counts down to the next hand once someone has readied, when bots ready up the rest', () => {
    const match = atBreak(['p4']);
    expect(nextHandClock(match, Date.parse(match.updatedOn) + 10_000)).toBe(LIVE_TURN_MS - 10_000);
    expect(nextHandClock(match, Date.parse(match.updatedOn) + LIVE_TURN_MS * 2)).toBe(0);
  });

  it("has no next hand clock while nobody has readied: running out pauses the table, it doesn't deal", () => {
    const match = atBreak([]);
    expect(nextHandClock(match, Date.parse(match.updatedOn) + 10_000)).toBeNull();
  });

  it('has no next hand clock mid-hand', () => {
    const match = dealtLive();
    expect(nextHandClock(match, Date.parse(match.updatedOn))).toBeNull();
  });
});

describe('turnClock on a paused table', () => {
  it('shows the last player overdue', () => {
    const solo = soloWithBots(); // p1 + bot-1..3, dealt, p1 to act
    const clock = turnClock(solo, Date.parse(solo.updatedOn) + LIVE_TURN_MS + 5000);
    expect(clock).toEqual({ playerIds: ['p1'], remainingMs: 0, paused: true });
  });

  it('counts down normally until the turn has run out', () => {
    const solo = soloWithBots();
    const clock = turnClock(solo, Date.parse(solo.updatedOn) + 10_000);
    expect(clock).toEqual({ playerIds: ['p1'], remainingMs: LIVE_TURN_MS - 10_000, paused: false });
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
