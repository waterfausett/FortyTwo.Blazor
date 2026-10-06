import { describe, it, expect } from 'vitest';
import {
  Bid,
  Suit,
  Teams,
  createDomino,
  createMatch,
  createTrick,
  shuffledDominoOrder,
  takeSeat,
  type Game,
  type Hand,
  type MatchState,
} from '@fortytwo/rules';
import type { Bot } from '@fortytwo/bot';
import {
  BOT_DELAY_MS, isBot, decideBid, decideTrump, decideDomino, findNextBotAction, applyBotAction, botDelayMs, botsEnabled,
} from './bots';

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

  it('keeps playing out a decided hand once every bot is ready', () => {
    const match = baseMatch({
      currentGame: baseGame({
        currentPlayerId: 'bot-1',
        biddingPlayerId: 'p1',
        bid: Bid.Thirty,
        trump: Suit.Low,
        hands: [
          emptyHand('p1', [createDomino(1, 2)], Bid.Thirty),
          { ...emptyHand('bot-1', [createDomino(3, 4)], Bid.Pass), team: Teams.TeamB },
        ],
        tricks: [{ playerId: 'p1', team: Teams.TeamA, suit: Suit.Sixes, dominoes: [] }],
      }),
      players: [
        { playerId: 'p1', position: 0, ready: false },
        { playerId: 'bot-1', position: 1, ready: true },
      ],
    });
    expect(findNextBotAction(match)).toEqual({ kind: 'play', playerId: 'bot-1' });
  });

  it('stops once a decided hand has been played to the last domino', () => {
    const match = baseMatch({
      currentGame: baseGame({
        currentPlayerId: 'bot-1',
        biddingPlayerId: 'p1',
        bid: Bid.Thirty,
        trump: Suit.Low,
        hands: [emptyHand('p1', [], Bid.Thirty), { ...emptyHand('bot-1', [], Bid.Pass), team: Teams.TeamB }],
        tricks: [{ playerId: 'p1', team: Teams.TeamA, suit: Suit.Sixes, dominoes: [] }],
      }),
      players: [
        { playerId: 'p1', position: 0, ready: false },
        { playerId: 'bot-1', position: 1, ready: true },
      ],
    });
    expect(findNextBotAction(match)).toBeNull();
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

// A dealt match (a human in seat 0, bots in 1-3) with bot-1 to open the bidding.
function botToBid(): MatchState {
  let m = createMatch('human');
  m = takeSeat(m, 'bot-1', 1);
  m = takeSeat(m, 'bot-2', 2);
  m = takeSeat(m, 'bot-3', 3, shuffledDominoOrder(() => 0.5));
  return { ...m, currentGame: { ...m.currentGame, firstActionBy: 'bot-1', currentPlayerId: 'bot-1' } };
}
const bidOf = (m: MatchState, id: string) => m.currentGame.hands.find((h) => h.playerId === id)!.bid;
const unused = () => {
  throw new Error('not used in this test');
};

describe('applyBotAction with an ML bot', () => {
  it('uses the ML decision when it is legal', () => {
    const match = botToBid();
    const action = findNextBotAction(match)!;
    expect(action).toEqual({ kind: 'bid', playerId: 'bot-1' });
    const bot: Bot = { decideBid: () => Bid.ThirtyFive, decideTrump: unused, decideDomino: unused };
    expect(bidOf(applyBotAction(match, action, bot), 'bot-1')).toBe(Bid.ThirtyFive);
  });

  it('falls back when the ML decision is illegal', () => {
    const match = botToBid();
    const action = findNextBotAction(match)!;
    const bot: Bot = { decideBid: () => 999 as Bid, decideTrump: unused, decideDomino: unused };
    expect(bidOf(applyBotAction(match, action, bot), 'bot-1')).toBe(Bid.Pass); // the simple bot passes
  });

  it('falls back when the ML bot throws', () => {
    const match = botToBid();
    const action = findNextBotAction(match)!;
    const bot: Bot = { decideBid: unused, decideTrump: unused, decideDomino: unused };
    expect(bidOf(applyBotAction(match, action, bot), 'bot-1')).toBe(Bid.Pass);
  });

  it('missing model falls back to the simple bots', () => {
    const match = botToBid();
    const action = findNextBotAction(match)!;
    expect(bidOf(applyBotAction(match, action, null), 'bot-1')).toBe(Bid.Pass);
  });
});

describe('botDelayMs', () => {
  const play = { kind: 'play', playerId: 'bot-1' } as const;
  const withTricks = (tricks: number, played: number): MatchState => {
    const m = botToBid();
    const currentTrick = createTrick();
    for (let i = 0; i < played; i++) currentTrick.dominoes[i] = createDomino(i, 6);
    return {
      ...m,
      currentGame: { ...m.currentGame, tricks: Array.from({ length: tricks }, () => createTrick()), currentTrick },
    };
  };

  it('paces bids and trump by kind', () => {
    expect(botDelayMs(botToBid(), { kind: 'bid', playerId: 'bot-1' })).toBe(BOT_DELAY_MS.bid);
    expect(botDelayMs(botToBid(), { kind: 'setTrump', playerId: 'bot-1' })).toBe(BOT_DELAY_MS.setTrump);
  });

  it('waits longer before leading a trick when one has just finished', () => {
    expect(botDelayMs(withTricks(0, 0), play)).toBe(BOT_DELAY_MS.play); // the hand's opening lead
    expect(botDelayMs(withTricks(2, 1), play)).toBe(BOT_DELAY_MS.play); // following in a trick
    expect(botDelayMs(withTricks(2, 0), play)).toBe(BOT_DELAY_MS.leadAfterTrick);
  });
});

describe('botsEnabled', () => {
  it('is on unless BOTS_ENABLED is exactly "false"', () => {
    expect(botsEnabled({})).toBe(true);
    expect(botsEnabled({ BOTS_ENABLED: 'true' })).toBe(true);
    expect(botsEnabled({ BOTS_ENABLED: 'false' })).toBe(false);
  });
});
