import { describe, it, expect } from 'vitest';
import { Game, gameValue, gameWinningTeam } from './game';
import { Trick } from './trick';
import { createDomino, Domino } from './domino';
import { Suit } from './suit';
import { Bid } from './bid';
import { Teams } from './teams';
import { Hand } from './hand';

function biddingHand(bid: Bid | null, team: Teams = Teams.TeamA): Hand {
  return { playerId: 'p1', team, dominoes: [], bid };
}

function otherHand(team: Teams = Teams.TeamB): Hand {
  return { playerId: 'p2', team, dominoes: [], bid: null };
}

function wonTrick(team: Teams, dominoes: Domino[]): Trick {
  const padded: (Domino | null)[] = [...dominoes];
  while (padded.length < 4) padded.push(null);
  return { playerId: null, team, suit: null, dominoes: padded };
}

function baseGame(overrides: Partial<Game>): Game {
  return {
    id: 'g1',
    name: 'Game 1',
    firstActionBy: null,
    bid: null,
    biddingPlayerId: null,
    trump: null,
    currentPlayerId: null,
    hands: [],
    currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
    tricks: [],
    ...overrides,
  };
}

describe('gameValue', () => {
  it('is null when there is no bidding player', () => {
    const g = baseGame({ biddingPlayerId: null });
    expect(gameValue(g)).toBeNull();
  });

  it('is 1 mark when the bid is 42 or less', () => {
    const g = baseGame({ biddingPlayerId: 'p1', hands: [biddingHand(Bid.Thirty)] });
    expect(gameValue(g)).toBe(1);
  });

  it('is bid/42 marks when the bid exceeds 42', () => {
    const g = baseGame({ biddingPlayerId: 'p1', hands: [biddingHand(Bid.EightyFour)] });
    expect(gameValue(g)).toBe(2);
  });

  it('is null when the bidding player has no recorded bid', () => {
    const g = baseGame({ biddingPlayerId: 'p1', hands: [biddingHand(null)] });
    expect(gameValue(g)).toBeNull();
  });
});

describe('gameWinningTeam', () => {
  it('(a) non-Low: bidding team wins by meeting their bid', () => {
    const g = baseGame({
      biddingPlayerId: 'p1',
      bid: Bid.Thirty,
      trump: Suit.Sixes,
      hands: [biddingHand(Bid.Thirty, Teams.TeamA), otherHand(Teams.TeamB)],
      tricks: [
        wonTrick(Teams.TeamA, [
          createDomino(5, 0), // 5
          createDomino(5, 5), // 10
          createDomino(6, 4), // 10
          createDomino(4, 1), // 5
        ]), // value = 30 + 1 = 31 >= 30
      ],
    });
    expect(gameWinningTeam(g)).toBe(Teams.TeamA);
  });

  it('(b) non-Low: bidding team falls short and the other team crosses 42 - bid', () => {
    const g = baseGame({
      biddingPlayerId: 'p1',
      bid: Bid.Thirty,
      trump: Suit.Sixes,
      hands: [biddingHand(Bid.Thirty, Teams.TeamA), otherHand(Teams.TeamB)],
      tricks: [
        wonTrick(Teams.TeamA, [
          createDomino(1, 2), // 0
          createDomino(1, 3), // 0
        ]), // value = 0 + 1 = 1 < 30
        wonTrick(Teams.TeamB, [
          createDomino(5, 5), // 10
          createDomino(6, 4), // 10
          createDomino(4, 1), // 5
        ]), // value = 25 + 1 = 26 > (42 - 30 = 12)
      ],
    });
    expect(gameWinningTeam(g)).toBe(Teams.TeamB);
  });

  it('(c) Low: bidding team takes zero tricks and all 7 have been played -> bidding team wins', () => {
    const tricks: Trick[] = [];
    for (let i = 0; i < 7; i++) {
      tricks.push(wonTrick(Teams.TeamB, [createDomino(1, 1)]));
    }
    const g = baseGame({
      biddingPlayerId: 'p1',
      bid: Bid.Thirty,
      trump: Suit.Low,
      hands: [biddingHand(Bid.Thirty, Teams.TeamA), otherHand(Teams.TeamB)],
      tricks,
    });
    expect(gameWinningTeam(g)).toBe(Teams.TeamA);
  });

  it('(d) Low: bidding team takes any trick -> other team wins immediately, without waiting for 7', () => {
    const g = baseGame({
      biddingPlayerId: 'p1',
      bid: Bid.Thirty,
      trump: Suit.Low,
      hands: [biddingHand(Bid.Thirty, Teams.TeamA), otherHand(Teams.TeamB)],
      tricks: [wonTrick(Teams.TeamA, [createDomino(0, 0)]), wonTrick(Teams.TeamB, [createDomino(1, 1)])],
    });
    expect(gameWinningTeam(g)).toBe(Teams.TeamB);
  });

  it('returns null when no bidding player is set', () => {
    const g = baseGame({ biddingPlayerId: null });
    expect(gameWinningTeam(g)).toBeNull();
  });

  it('returns null (undetermined) when neither threshold has been crossed yet', () => {
    const g = baseGame({
      biddingPlayerId: 'p1',
      bid: Bid.Thirty,
      trump: Suit.Sixes,
      hands: [biddingHand(Bid.Thirty, Teams.TeamA), otherHand(Teams.TeamB)],
      tricks: [wonTrick(Teams.TeamA, [createDomino(1, 2)])], // value 1, far below 30
    });
    expect(gameWinningTeam(g)).toBeNull();
  });
});
