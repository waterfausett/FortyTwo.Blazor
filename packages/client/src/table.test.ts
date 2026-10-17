import { describe, expect, it } from 'vitest';
import {
  Bid,
  createDomino,
  createMatch,
  createTrick,
  parkSeat,
  Positions,
  Suit,
  takeSeat,
  Teams,
  type Domino,
  type Game,
  type MatchPlayerState,
  type MatchState,
} from '@fortytwo/rules';
import { dealerId, openSeats, seatFor, trickLeaderId, trickPlayOrder, trickSeats } from './table';

const PLAYERS: MatchPlayerState[] = [
  { playerId: 'p1', position: Positions.First, ready: true },
  { playerId: 'p2', position: Positions.Second, ready: true },
  { playerId: 'p3', position: Positions.Third, ready: true },
  { playerId: 'p4', position: Positions.Fourth, ready: true },
];

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 'g1',
    name: 'Game 1',
    firstActionBy: 'p1',
    bid: Bid.Thirty,
    biddingPlayerId: 'p2',
    trump: Suit.Sixes,
    currentPlayerId: 'p2',
    hands: [],
    currentTrick: createTrick(),
    tricks: [],
    ...overrides,
  };
}

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// p1-p4 dealt in a Custom match, then p2 leaves: a parked bot holds position 1 while the hand is played.
function parkedMidHand(): MatchState {
  let match = createMatch('p1', 'custom');
  match = takeSeat(match, 'p2', 1);
  match = takeSeat(match, 'p3', 2);
  match = takeSeat(match, 'p4', 3, deck());
  return parkSeat(match, 'p2');
}

// The same match with the hand decided (a team has taken 31 points), so the parked seat is open.
function openParkedMatch(): MatchState {
  const match = parkedMidHand();
  const counts = [createDomino(5, 5), createDomino(6, 4), createDomino(5, 0), createDomino(4, 1)];
  return {
    ...match,
    currentGame: {
      ...match.currentGame,
      biddingPlayerId: 'p1',
      bid: Bid.Thirty,
      trump: Suit.Sixes,
      tricks: [{ playerId: 'p2', team: Teams.TeamB, suit: Suit.Sixes, dominoes: counts }],
    },
  };
}

describe('seatFor', () => {
  it('places the next player to my left, my partner across, and the previous player to my right', () => {
    expect(seatFor(PLAYERS, 'p2', 'p2')).toBe('bottom');
    expect(seatFor(PLAYERS, 'p2', 'p3')).toBe('left');
    expect(seatFor(PLAYERS, 'p2', 'p4')).toBe('top');
    expect(seatFor(PLAYERS, 'p2', 'p1')).toBe('right');
  });

  it('returns null for someone not at the table', () => {
    expect(seatFor(PLAYERS, 'p1', 'nobody')).toBeNull();
  });
});

describe('openSeats', () => {
  it('lists each empty position with where it sits relative to me', () => {
    // I'm at position 1; p3 sits across from me at 3. Positions 0 and 2 are open.
    const match = { ...createMatch('p1'), players: [PLAYERS[1], PLAYERS[3]] };
    expect(openSeats(match, 'p2')).toEqual([
      { position: 0, seat: 'right' },
      { position: 2, seat: 'left' },
    ]);
  });

  it('is empty once the table is full', () => {
    expect(openSeats({ ...createMatch('p1'), players: PLAYERS }, 'p1')).toEqual([]);
  });

  it('lists an open parked seat', () => {
    expect(openSeats(openParkedMatch(), 'p1')).toEqual([{ position: 1, seat: 'left' }]);
  });

  it('does not list a parked seat whose hand is still being played', () => {
    expect(openSeats(parkedMidHand(), 'p1')).toEqual([]);
  });
});

describe('dealerId', () => {
  it('is the player seated just before whoever acts first', () => {
    expect(dealerId(PLAYERS, game({ firstActionBy: 'p1' }))).toBe('p4');
    expect(dealerId(PLAYERS, game({ firstActionBy: 'p3' }))).toBe('p2');
  });

  it('is unknown until the table is full', () => {
    expect(dealerId(PLAYERS.slice(0, 2), game())).toBeNull();
  });
});

describe('trickLeaderId', () => {
  it('has the high bidder lead the first trick', () => {
    expect(trickLeaderId(PLAYERS, game({ biddingPlayerId: 'p2' }), 0)).toBe('p2');
  });

  it("has the bidder's partner lead the first trick on a Plunge", () => {
    expect(trickLeaderId(PLAYERS, game({ bid: Bid.Plunge, biddingPlayerId: 'p2' }), 0)).toBe('p4');
  });

  it('has the previous trick winner lead every later trick', () => {
    const won = { ...createTrick(), playerId: 'p3', team: Teams.TeamA };
    expect(trickLeaderId(PLAYERS, game({ tricks: [won] }), 1)).toBe('p3');
  });
});

describe('trickPlayOrder', () => {
  it('runs clockwise from the leader', () => {
    expect(trickPlayOrder(PLAYERS, game(), 'p3')).toEqual(['p3', 'p4', 'p1', 'p2']);
  });

  it("skips the bidder's partner when Low is trump", () => {
    // p2 bid Low; p4 (their partner) sits out.
    expect(trickPlayOrder(PLAYERS, game({ trump: Suit.Low, biddingPlayerId: 'p2' }), 'p2').slice(0, 3)).toEqual([
      'p2',
      'p3',
      'p1',
    ]);
  });
});

describe('trickSeats', () => {
  it("maps each slot of the current trick to the seat of whoever played it, from the viewer's side", () => {
    const { leaderId, slotSeats } = trickSeats(PLAYERS, 'p1', game({ biddingPlayerId: 'p2' }), 0);
    expect(leaderId).toBe('p2');
    expect(slotSeats).toEqual(['left', 'top', 'right', 'bottom']);
  });
});
