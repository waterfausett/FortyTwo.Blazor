import { describe, it, expect } from 'vitest';
import {
  Bid,
  Suit,
  Teams,
  createDomino,
  createTrick,
  type Game,
  type Hand,
  type MatchState,
} from '@fortytwo/rules';
import { isBot, shuffledDominoOrder, decideBid, decideTrump, decideDomino, findNextBotAction } from './bots';

function emptyHand(playerId: string, dominoes: ReturnType<typeof createDomino>[] = [], bid: Bid | null = null): Hand {
  return { playerId, team: Teams.TeamA, dominoes, bid };
}

function baseGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'g1',
    name: 'Game 1',
    firstActionBy: 'p1',
    bid: null,
    biddingPlayerId: null,
    trump: null,
    currentPlayerId: 'p1',
    hands: [],
    currentTrick: createTrick(),
    tricks: [],
    ...overrides,
  };
}

function baseMatch(overrides: Partial<MatchState> = {}): MatchState {
  return {
    id: 'm1',
    createdOn: 'x',
    updatedOn: 'x',
    currentGame: baseGame(),
    games: {},
    winningTeam: null,
    players: [],
    ...overrides,
  };
}

describe('isBot', () => {
  it('recognizes reserved bot ids and rejects everything else', () => {
    expect(isBot('bot-1')).toBe(true);
    expect(isBot('bot-2')).toBe(true);
    expect(isBot('bot-3')).toBe(true);
    expect(isBot('human-p1')).toBe(false);
  });
});

describe('shuffledDominoOrder', () => {
  it('produces all 28 unique dominoes', () => {
    const order = shuffledDominoOrder();
    expect(order).toHaveLength(28);
    expect(new Set(order.map((d) => d.id)).size).toBe(28);
  });
});

describe('decideBid', () => {
  it('passes when not forced to bid', () => {
    const game = baseGame({ hands: [emptyHand('bot-1', [], null)] });
    expect(decideBid(game, game.hands[0])).toBe(Bid.Pass);
  });

  it('bids the minimum when the other three players have all passed', () => {
    const game = baseGame({
      hands: [
        emptyHand('p1', [], Bid.Pass),
        emptyHand('p2', [], Bid.Pass),
        emptyHand('p3', [], Bid.Pass),
        emptyHand('bot-1', [], null),
      ],
    });
    expect(decideBid(game, game.hands[3])).toBe(Bid.Thirty);
  });
});

describe('decideTrump', () => {
  it('picks the suit the bot holds the most of', () => {
    const hand = emptyHand('bot-1', [
      createDomino(2, 2),
      createDomino(2, 5),
      createDomino(3, 4),
      createDomino(0, 1),
    ]);
    expect(decideTrump(hand)).toBe(Suit.Deuces);
  });
});

describe('decideDomino', () => {
  it('leads with its first domino when the trick is empty', () => {
    const hand = emptyHand('bot-1', [createDomino(6, 6), createDomino(1, 2)]);
    const game = baseGame({ trump: Suit.Sixes });
    expect(decideDomino(game, hand)).toEqual(createDomino(6, 6));
  });

  it('follows suit when it can', () => {
    const hand = emptyHand('bot-1', [createDomino(1, 2), createDomino(3, 3)]);
    const game = baseGame({ trump: Suit.Sixes, currentTrick: { ...createTrick(), suit: Suit.Threes } });
    expect(decideDomino(game, hand)).toEqual(createDomino(3, 3));
  });

  it('plays anything when it cannot follow suit', () => {
    const hand = emptyHand('bot-1', [createDomino(1, 2), createDomino(0, 4)]);
    const game = baseGame({ trump: Suit.Sixes, currentTrick: { ...createTrick(), suit: Suit.Threes } });
    expect(decideDomino(game, hand)).toEqual(createDomino(1, 2));
  });
});

describe('findNextBotAction', () => {
  it('returns null once the match is over', () => {
    const match = baseMatch({ winningTeam: Teams.TeamA });
    expect(findNextBotAction(match)).toBeNull();
  });

  it('returns a ready action for an un-readied bot once the current game is decided', () => {
    // trump: Low is the simplest way to make gameWinningTeam (game.ts) resolve deterministically
    // for a fixture: the bidding team (TeamA) losing the instant it's on the board for any points,
    // regardless of magnitude - real match logic, exercised as a black box, not re-implemented here.
    const match = baseMatch({
      currentGame: baseGame({
        biddingPlayerId: 'p1',
        bid: Bid.Thirty,
        trump: Suit.Low,
        hands: [emptyHand('p1', [], Bid.Thirty), { ...emptyHand('p2', [], Bid.Pass), team: Teams.TeamB }],
        tricks: [{ playerId: 'p1', team: Teams.TeamA, suit: Suit.Sixes, dominoes: [] }],
      }),
      players: [
        { playerId: 'p1', position: 0, ready: true },
        { playerId: 'bot-1', position: 1, ready: false },
      ],
    });
    expect(findNextBotAction(match)).toEqual({ kind: 'ready', playerId: 'bot-1' });
  });

  it('returns a bid action when it is a bot\'s turn during bidding', () => {
    const match = baseMatch({
      currentGame: baseGame({
        currentPlayerId: 'bot-1',
        hands: [emptyHand('p1', [], Bid.Pass), emptyHand('bot-1', [], null)],
      }),
    });
    expect(findNextBotAction(match)).toEqual({ kind: 'bid', playerId: 'bot-1' });
  });

  it('returns a setTrump action once bidding is complete but trump is unset', () => {
    const match = baseMatch({
      currentGame: baseGame({
        currentPlayerId: 'bot-1',
        biddingPlayerId: 'bot-1',
        bid: Bid.Thirty,
        trump: null,
        hands: [emptyHand('p1', [], Bid.Pass), emptyHand('bot-1', [], Bid.Thirty)],
      }),
    });
    expect(findNextBotAction(match)).toEqual({ kind: 'setTrump', playerId: 'bot-1' });
  });

  it('returns a play action once bidding and trump are settled', () => {
    const match = baseMatch({
      currentGame: baseGame({
        currentPlayerId: 'bot-1',
        biddingPlayerId: 'bot-1',
        bid: Bid.Thirty,
        trump: Suit.Sixes,
        hands: [emptyHand('p1', [], Bid.Pass), emptyHand('bot-1', [createDomino(1, 1)], Bid.Thirty)],
      }),
    });
    expect(findNextBotAction(match)).toEqual({ kind: 'play', playerId: 'bot-1' });
  });

  it('returns null when it is a human\'s turn', () => {
    const match = baseMatch({
      currentGame: baseGame({
        currentPlayerId: 'p1',
        hands: [emptyHand('p1', [], null), emptyHand('bot-1', [], null)],
      }),
    });
    expect(findNextBotAction(match)).toBeNull();
  });
});
