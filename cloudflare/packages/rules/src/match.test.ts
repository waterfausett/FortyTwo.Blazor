import { describe, it, expect } from 'vitest';
import { selectNextPlayer, MatchPlayerRef } from './match';
import { Positions } from './positions';
import { Suit } from './suit';

const players: MatchPlayerRef[] = [
  { playerId: 'p1', position: Positions.First },
  { playerId: 'p2', position: Positions.Second },
  { playerId: 'p3', position: Positions.Third },
  { playerId: 'p4', position: Positions.Fourth },
];

describe('selectNextPlayer', () => {
  it('advances to the next position in normal (non-Low) play', () => {
    expect(selectNextPlayer('p1', 'p1', Suit.Sixes, players)).toBe('p2');
    expect(selectNextPlayer('p4', 'p1', Suit.Sixes, players)).toBe('p1');
  });

  it('returns the current player id unchanged when currentPlayerId is empty', () => {
    expect(selectNextPlayer('', 'p1', Suit.Sixes, players)).toBe('');
    expect(selectNextPlayer('   ', 'p1', Suit.Sixes, players)).toBe('   ');
  });

  it('under Low trump, skips the bidding player\'s partner (same-parity position) by advancing twice', () => {
    // Bidding player p1 is at position First (0). Partner is Third (2) - same parity (both even).
    // Current player p2 (Second, position 1) would normally advance to p3 (Third, position 2),
    // which shares parity with the bidder's position (0 % 2 === 2 % 2) and isn't the bidder's
    // own position, so it must skip ahead to p4 (Fourth, position 3).
    expect(selectNextPlayer('p2', 'p1', Suit.Low, players)).toBe('p4');
  });

  it('under Low trump, does not skip when the next position is the bidding player\'s own position', () => {
    // Current player p4 (Fourth, position 3) advances to p1 (First, position 0), which IS the
    // bidding player's own position - no skip should occur even though parity matches.
    expect(selectNextPlayer('p4', 'p1', Suit.Low, players)).toBe('p1');
  });

  it('under Low trump, does not skip when the next position has different parity from the bidder', () => {
    // Current player p1 (First, 0) advances to p2 (Second, 1) - different parity from bidder (0) - no skip.
    expect(selectNextPlayer('p1', 'p1', Suit.Low, players)).toBe('p2');
  });
});
