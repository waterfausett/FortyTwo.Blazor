import { describe, expect, it } from 'vitest';
import { Bid, Suit, Teams, type Game, type MatchState } from '@fortytwo/rules';
import { playedHands } from './summary';

function hand(name: string, bidder: string, bid: Bid, trump: Suit, bidderTeam: Teams): Game {
  return {
    id: name,
    name,
    firstActionBy: 'p1',
    bid,
    biddingPlayerId: bidder,
    trump,
    currentPlayerId: null,
    hands: [
      { playerId: bidder, team: bidderTeam, dominoes: [], bid },
      { playerId: 'other', team: bidderTeam === Teams.TeamA ? Teams.TeamB : Teams.TeamA, dominoes: [], bid: Bid.Pass },
    ],
    currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
    tricks: [],
  };
}

describe('playedHands', () => {
  it("lists both teams' hands in game order, marking each made or set", () => {
    const match = {
      games: {
        [Teams.TeamA]: [
          hand('Game 1', 'p1', Bid.Thirty, Suit.Fives, Teams.TeamA),
          hand('Game 10', 'p1', Bid.EightyFour, Suit.Sixes, Teams.TeamA),
        ],
        [Teams.TeamB]: [hand('Game 2', 'p1', Bid.ThirtyOne, Suit.Aces, Teams.TeamA)],
      },
    } as unknown as MatchState;

    expect(playedHands(match).map((h) => [h.game.name, h.winner, h.made, h.marks])).toEqual([
      ['Game 1', Teams.TeamA, true, 1],
      ['Game 2', Teams.TeamB, false, 1],
      ['Game 10', Teams.TeamA, true, 2],
    ]);
  });

  it('is empty when no hand has been decided', () => {
    expect(playedHands({ games: {} } as MatchState)).toEqual([]);
  });
});
