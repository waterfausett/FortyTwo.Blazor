import { describe, it, expect } from 'vitest';
import { matchStatsFor } from './stats';
import { Bid } from './bid';
import { Suit } from './suit';
import { Teams } from './teams';
import type { Game } from './game';
import type { MatchState } from './matchEngine';
import type { Positions } from './positions';

// A filed hand: who bid what, and the team that took it. Only the fields stats read are real.
function hand(n: number, bidder: string, bidderTeam: Teams, bid: Bid, trump: Suit = Suit.Sixes): Game {
  return {
    id: `g${n}`,
    name: `Game ${n}`,
    firstActionBy: null,
    bid,
    biddingPlayerId: bidder,
    trump,
    currentPlayerId: null,
    hands: [{ playerId: bidder, team: bidderTeam, dominoes: [], bid }],
    currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
    tricks: [],
  };
}

function match(players: string[], games: MatchState['games'], winningTeam: Teams | null): MatchState {
  return {
    id: 'm1',
    createdOn: '2026-10-01T00:00:00.000Z',
    updatedOn: '2026-10-01T01:00:00.000Z',
    winningTeam,
    games,
    players: players.map((playerId, position) => ({ playerId, position: position as Positions, ready: true })),
    currentGame: hand(99, players[0], Teams.TeamA, Bid.Thirty),
  };
}

describe('matchStatsFor', () => {
  // Seats 0 & 2 are TeamA, 1 & 3 TeamB.
  const players = ['p1', 'p2', 'p3', 'p4'];

  it('is empty while the match is still being played', () => {
    expect(matchStatsFor(match(players, {}, null))).toEqual([]);
  });

  it('counts the result, marks and bids for each player', () => {
    const games: MatchState['games'] = {
      // TeamA: p1 made 30 and 34, p3 made 84 (2 marks); then set p2's Plunge (4 marks).
      [Teams.TeamA]: [
        hand(1, 'p1', Teams.TeamA, Bid.Thirty),
        hand(2, 'p1', Teams.TeamA, Bid.ThirtyFour),
        hand(3, 'p3', Teams.TeamA, Bid.EightyFour),
        hand(5, 'p2', Teams.TeamB, Bid.Plunge),
      ],
      // TeamB: set p1's 36.
      [Teams.TeamB]: [hand(4, 'p1', Teams.TeamA, Bid.ThirtySix)],
    };

    const stats = matchStatsFor(match(players, games, Teams.TeamA));

    expect(stats.find((s) => s.playerId === 'p1')).toEqual({
      playerId: 'p1',
      partnerId: 'p3',
      withBots: false,
      won: true,
      marksWon: 1 + 1 + 2 + 4,
      bidsWon: 3,
      bidsMade: 2,
      pointsBidTotal: 30 + 34 + 36,
      pointsBidCount: 3,
      marksBids: 0,
    });
    expect(stats.find((s) => s.playerId === 'p3')).toMatchObject({ partnerId: 'p1', bidsWon: 1, bidsMade: 1, marksBids: 1, pointsBidCount: 0 });
    expect(stats.find((s) => s.playerId === 'p2')).toEqual({
      playerId: 'p2',
      partnerId: 'p4',
      withBots: false,
      won: false,
      marksWon: 1,
      bidsWon: 1,
      bidsMade: 0,
      pointsBidTotal: 0,
      pointsBidCount: 0,
      marksBids: 1,
    });
  });

  it('counts a made Low bid as made', () => {
    const games = { [Teams.TeamA]: [hand(1, 'p1', Teams.TeamA, Bid.FortyTwo, Suit.Low)] };
    expect(matchStatsFor(match(players, games, Teams.TeamA))[0]).toMatchObject({ bidsWon: 1, bidsMade: 1 });
  });

  it('gives bots no row and marks the humans as playing with bots', () => {
    const stats = matchStatsFor(match(['p1', 'bot-1', 'bot-2', 'bot-3'], {}, Teams.TeamB));
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ playerId: 'p1', partnerId: 'bot-2', withBots: true, won: false });
  });
});
