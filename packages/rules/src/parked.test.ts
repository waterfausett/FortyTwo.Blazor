import { describe, it, expect } from 'vitest';
import {
  createMatch,
  takeSeat,
  patchPlayerReady,
  playDomino,
  matchScores,
  type MatchState,
} from './matchEngine';
import { isParked, openPositions, parkSeat, seatedPlayers } from './parked';
import { isBot } from './botIds';
import { Teams } from './teams';
import { Bid } from './bid';
import { Suit } from './suit';
import { createDomino, type Domino } from './domino';

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// p1-p4 seated in a match of `mode`; the fourth seat deals.
function dealt(mode: 'live' | 'daily' | 'custom' = 'custom'): MatchState {
  let match = createMatch('p1', mode);
  match = takeSeat(match, 'p2', 1);
  match = takeSeat(match, 'p3', 2);
  return takeSeat(match, 'p4', 3, deck());
}

// The current hand decided: seat 0 bid 30 and seat 1's team took one trick of 31 points, more than
// the 12 that sets the bid.
function decide(match: MatchState): MatchState {
  const bidder = match.players.find((p) => p.position === 0)!.playerId;
  const setter = match.players.find((p) => p.position === 1)!.playerId;
  const counts = [createDomino(5, 5), createDomino(6, 4), createDomino(5, 0), createDomino(4, 1)];
  return {
    ...match,
    currentGame: {
      ...match.currentGame,
      biddingPlayerId: bidder,
      bid: Bid.Thirty,
      trump: Suit.Sixes,
      tricks: [{ playerId: setter, team: Teams.TeamB, suit: Suit.Sixes, dominoes: counts }],
    },
  };
}

describe('parkSeat', () => {
  it('hands the seat to a parked, unready bot, without a replaced note', () => {
    const match = parkSeat(dealt('custom'), 'p2');
    const bot = match.players.find((p) => p.position === 1)!;
    expect(isBot(bot.playerId)).toBe(true);
    expect(isParked(match, bot.playerId)).toBe(true);
    expect(match.parked).toEqual([bot.playerId]);
    expect(bot.ready).toBe(false);
    expect(match.replaced ?? []).not.toContain('p2');
    expect(match.currentGame.hands.some((h) => h.playerId === 'p2')).toBe(false);
  });
  it('unreadies a leaver who had already readied', () => {
    const ready = patchPlayerReady(decide(dealt('custom')), 'p2', true, deck());
    const match = parkSeat(ready, 'p2');
    expect(match.players.find((p) => p.position === 1)!.ready).toBe(false);
  });
});

describe('openPositions', () => {
  it('is the empty seats before the deal', () => {
    expect(openPositions(takeSeat(createMatch('p1', 'custom'), 'p2', 1))).toEqual([2, 3]);
  });
  it('leaves a parked seat taken until the hand is decided, then opens it', () => {
    const parked = parkSeat(dealt('custom'), 'p2');
    expect(openPositions(parked)).toEqual([]);
    expect(seatedPlayers(parked)).toHaveLength(4);
    expect(openPositions(decide(parked))).toEqual([1]);
    expect(seatedPlayers(decide(parked)).map((p) => p.position)).toEqual([0, 2, 3]);
  });
});

describe('patchPlayerReady with a parked seat', () => {
  it('never deals while a seat is parked, even with its ready flag set', () => {
    let match = decide(parkSeat(dealt('custom'), 'p2'));
    // Every seat but p1's marked ready by hand, the parked bot's included.
    match = { ...match, players: match.players.map((p) => ({ ...p, ready: p.playerId !== 'p1' })) };
    const after = patchPlayerReady(match, 'p1', true, deck());
    expect(after.currentGame.id).toBe(match.currentGame.id);
  });
});

describe('winning the match', () => {
  it('clears parked', () => {
    const parked = parkSeat(dealt('custom'), 'p2');
    const botId = parked.parked![0];
    // Team A's deciding trick is down but the hand isn't filed, six hands already won, so p1's next
    // play files it and wins the match.
    const decidingTrick = {
      playerId: 'p1',
      team: Teams.TeamA,
      suit: Suit.Fives,
      dominoes: [createDomino(5, 5), createDomino(6, 4), createDomino(5, 0), createDomino(4, 1)],
    };
    const hand = (playerId: string, team: Teams, dominoes: Domino[]) => ({ playerId, team, dominoes, bid: Bid.Pass });
    const game = {
      ...parked.currentGame,
      bid: Bid.Thirty,
      biddingPlayerId: 'p1',
      trump: Suit.Sixes,
      currentPlayerId: 'p1',
      firstActionBy: 'p1',
      tricks: [decidingTrick],
      hands: [
        { ...hand('p1', Teams.TeamA, [createDomino(6, 6), createDomino(1, 2)]), bid: Bid.Thirty },
        hand(botId, Teams.TeamB, [createDomino(6, 3), createDomino(0, 0)]),
        hand('p3', Teams.TeamA, [createDomino(6, 1), createDomino(2, 2)]),
        hand('p4', Teams.TeamB, [createDomino(6, 0), createDomino(3, 3)]),
      ],
    };
    const earlierWins = Array.from({ length: 6 }, (_, i) => ({ ...game, id: `won-${i}` }));
    const almost = { ...parked, currentGame: game, games: { [Teams.TeamA]: earlierWins } };

    const wonMatch = playDomino(almost, 'p1', createDomino(6, 6));

    expect(matchScores(wonMatch)[Teams.TeamA]).toBe(7);
    expect(wonMatch.winningTeam).not.toBeNull();
    expect(wonMatch.parked).toBeUndefined();
  });
});
