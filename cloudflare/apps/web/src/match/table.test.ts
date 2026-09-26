import { describe, expect, it } from 'vitest';
import { Bid, createTrick, Positions, Suit, Teams, type Game, type MatchPlayerState } from '@fortytwo/rules';
import { dealerId, seatFor, trickLeaderId, trickPlayOrder, trickSeats } from './table';

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
