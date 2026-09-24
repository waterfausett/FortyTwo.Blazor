import { describe, it, expect } from 'vitest';
import {
  createMatch,
  addPlayer,
  patchPlayerReady,
  placeBid,
  setTrump,
  playDomino,
  getPlayerView,
  matchScores,
  MatchState,
} from './matchEngine';
import { ValidationError } from './errors';
import { Positions } from './positions';
import { Teams } from './teams';
import { Bid } from './bid';
import { Suit } from './suit';
import { createDomino, Domino } from './domino';
import { Game } from './game';
import { Hand } from './hand';
import { createTrick, Trick } from './trick';

// A full, shuffled-in-name-only 28-domino deck in a fixed, deterministic order — enough to
// deterministically deal 4 hands of 7 for tests. Order doesn't matter for correctness here,
// only that it's the real 28-tile double-six set.
function fullDeck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) {
    for (let j = i; j <= 6; j++) {
      dominoes.push(createDomino(i, j));
    }
  }
  return dominoes;
}

function baseHand(playerId: string, team: Teams, overrides: Partial<Hand> = {}): Hand {
  return { playerId, team, dominoes: [], bid: null, ...overrides };
}

// Standard 4-seat layout used by most fixtures below: p1..p4 at First..Fourth,
// alternating TeamA/TeamB by position parity (matches `Team()` extension).
function fourPlayers() {
  return [
    { playerId: 'p1', position: Positions.First, ready: true },
    { playerId: 'p2', position: Positions.Second, ready: true },
    { playerId: 'p3', position: Positions.Third, ready: true },
    { playerId: 'p4', position: Positions.Fourth, ready: true },
  ];
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
    hands: [
      baseHand('p1', Teams.TeamA),
      baseHand('p2', Teams.TeamB),
      baseHand('p3', Teams.TeamA),
      baseHand('p4', Teams.TeamB),
    ],
    currentTrick: createTrick(),
    tricks: [],
    ...overrides,
  };
}

function baseMatch(overrides: Partial<MatchState> = {}): MatchState {
  return {
    id: 'm1',
    createdOn: '2026-01-01T00:00:00.000Z',
    updatedOn: '2026-01-01T00:00:00.000Z',
    currentGame: baseGame(),
    games: {},
    winningTeam: null,
    players: fourPlayers(),
    ...overrides,
  };
}

describe('createMatch', () => {
  it('creates a match with a single player, seated First/TeamA, and a fresh current game', () => {
    const match = createMatch('p1');

    expect(match.players).toEqual([{ playerId: 'p1', position: Positions.First, ready: true }]);
    expect(match.winningTeam).toBeNull();
    expect(match.currentGame.firstActionBy).toBe('p1');
    expect(match.currentGame.currentPlayerId).toBe('p1');
    expect(match.currentGame.hands).toEqual([{ playerId: 'p1', team: Teams.TeamA, dominoes: [], bid: null }]);
  });
});

describe('addPlayer', () => {
  it('assigns team/position exactly like the real position math as players join in sequence', () => {
    let match = createMatch('p1'); // p1 @ First(0), TeamA

    match = addPlayer(match, 'p2', Teams.TeamA); // joins p1's team -> teammatePosition(0)+2 = Third(2)
    const p2 = match.players.find((p) => p.playerId === 'p2')!;
    expect(p2.position).toBe(Positions.Third);
    expect(match.currentGame.hands.find((h) => h.playerId === 'p2')!.team).toBe(Teams.TeamA);

    match = addPlayer(match, 'p3', Teams.TeamB); // no TeamB players yet; TeamA's first (p1) is at even
    // position(0) -> Second
    const p3 = match.players.find((p) => p.playerId === 'p3')!;
    expect(p3.position).toBe(Positions.Second);
    expect(match.currentGame.hands.find((h) => h.playerId === 'p3')!.team).toBe(Teams.TeamB);

    match = addPlayer(match, 'p4', Teams.TeamB, fullDeck()); // joins p3's team -> teammatePosition(1)+2 = Fourth(3)
    const p4 = match.players.find((p) => p.playerId === 'p4')!;
    expect(p4.position).toBe(Positions.Fourth);
    expect(match.currentGame.hands.find((h) => h.playerId === 'p4')!.team).toBe(Teams.TeamB);
  });

  it('deals automatically once the 4th hand is added, given a dealOrder', () => {
    let match = createMatch('p1');
    match = addPlayer(match, 'p2', Teams.TeamA);
    match = addPlayer(match, 'p3', Teams.TeamB);
    match = addPlayer(match, 'p4', Teams.TeamB, fullDeck());

    expect(match.currentGame.hands).toHaveLength(4);
    for (const hand of match.currentGame.hands) {
      expect(hand.dominoes).toHaveLength(7);
    }
    expect(match.players.every((p) => p.ready === false)).toBe(true);
  });

  it('rejects a 5th player (match is full)', () => {
    let match = createMatch('p1');
    match = addPlayer(match, 'p2', Teams.TeamA);
    match = addPlayer(match, 'p3', Teams.TeamB);
    match = addPlayer(match, 'p4', Teams.TeamB, fullDeck());

    expect(() => addPlayer(match, 'p5', Teams.TeamA)).toThrow(ValidationError);
  });

  it('rejects a player who is already seated', () => {
    let match = createMatch('p1');
    expect(() => addPlayer(match, 'p1', Teams.TeamB)).toThrow(ValidationError);
  });

  // Regression test for CRITICAL finding #3 from the final whole-branch review: without a
  // team-capacity guard, a 3rd player requesting an already-full team collides with the 2nd
  // player's position (both compute `teammatePosition + 2` from the same first teammate),
  // corrupting the players array - this later crashes `selectNextPlayer`'s non-null assertion
  // when turn order needs to reach the never-assigned position. Must throw ValidationError
  // BEFORE any position math runs, not corrupt state.
  it('rejects a 3rd player requesting a team that already has 2 players (prevents position collision)', () => {
    let match = createMatch('p1'); // p1 @ First(0), TeamA
    match = addPlayer(match, 'p2', Teams.TeamA); // p2 @ Third(2), TeamA - TeamA now full

    expect(() => addPlayer(match, 'p3', Teams.TeamA)).toThrow(ValidationError);
    try {
      addPlayer(match, 'p3', Teams.TeamA);
    } catch (e) {
      expect((e as ValidationError).title).toBe('Team is full');
    }

    // Confirm no corruption: TeamA still has exactly the original 2 players/positions, and a 3rd
    // (TeamB) player can still join cleanly at a distinct position.
    expect(match.players).toHaveLength(2);
    const p3 = addPlayer(match, 'p3', Teams.TeamB);
    const p3Player = p3.players.find((p) => p.playerId === 'p3')!;
    expect(new Set(p3.players.map((p) => p.position)).size).toBe(3); // all 3 positions distinct
    expect(p3Player.position).not.toBe(Positions.First);
    expect(p3Player.position).not.toBe(Positions.Third);
  });
});

describe('patchPlayerReady', () => {
  // A finished game: TeamA bid Thirty and won a single trick worth 31 (>= 30).
  function finishedGame(): Game {
    return baseGame({
      id: 'finished-game',
      firstActionBy: 'p1',
      bid: Bid.Thirty,
      biddingPlayerId: 'p1',
      trump: Suit.Sixes,
      hands: [
        baseHand('p1', Teams.TeamA, { bid: Bid.Thirty }),
        baseHand('p2', Teams.TeamB, { bid: Bid.Pass }),
        baseHand('p3', Teams.TeamA, { bid: Bid.Pass }),
        baseHand('p4', Teams.TeamB, { bid: Bid.Pass }),
      ],
      tricks: [
        {
          playerId: 'p1',
          team: Teams.TeamA,
          suit: Suit.Sixes,
          dominoes: [createDomino(5, 0), createDomino(5, 5), createDomino(6, 4), createDomino(4, 1)],
        } as Trick,
      ],
    });
  }

  it('triggers a new deal only once all 4 players are ready AND the previous game had a winner', () => {
    const match = baseMatch({
      currentGame: finishedGame(),
      games: { [Teams.TeamA]: [finishedGame()] },
      players: [
        { playerId: 'p1', position: Positions.First, ready: true },
        { playerId: 'p2', position: Positions.Second, ready: true },
        { playerId: 'p3', position: Positions.Third, ready: true },
        { playerId: 'p4', position: Positions.Fourth, ready: false },
      ],
    });

    const result = patchPlayerReady(match, 'p4', true, fullDeck());

    // New game dealt: id changed, name reflects total games played so far (1) + 1.
    expect(result.currentGame.id).not.toBe('finished-game');
    expect(result.currentGame.name).toBe('Game 2');
    // firstActionBy rotates from p1 (First) to the player at the next position (p2, Second).
    expect(result.currentGame.firstActionBy).toBe('p2');
    expect(result.currentGame.currentPlayerId).toBe('p2');
    expect(result.currentGame.bid).toBeNull();
    expect(result.currentGame.biddingPlayerId).toBeNull();
    expect(result.currentGame.trump).toBeNull();
    expect(result.currentGame.hands).toHaveLength(4);
    for (const hand of result.currentGame.hands) {
      expect(hand.dominoes).toHaveLength(7);
      expect(hand.bid).toBeNull();
    }
    // All players reset to not-ready after the deal.
    expect(result.players.every((p) => p.ready === false)).toBe(true);
  });

  it('does NOT deal when not all players are ready yet, even if the previous game finished', () => {
    const match = baseMatch({
      currentGame: finishedGame(),
      games: { [Teams.TeamA]: [finishedGame()] },
      players: [
        { playerId: 'p1', position: Positions.First, ready: true },
        { playerId: 'p2', position: Positions.Second, ready: true },
        { playerId: 'p3', position: Positions.Third, ready: false },
        { playerId: 'p4', position: Positions.Fourth, ready: false },
      ],
    });

    const result = patchPlayerReady(match, 'p3', true, fullDeck());

    expect(result.currentGame.id).toBe('finished-game');
    expect(result.players.find((p) => p.playerId === 'p3')!.ready).toBe(true);
    expect(result.players.find((p) => p.playerId === 'p4')!.ready).toBe(false);
  });

  it('does NOT deal when all are ready but the previous game has no winner yet', () => {
    const unfinished = baseGame({ id: 'unfinished-game', biddingPlayerId: null });
    const match = baseMatch({
      currentGame: unfinished,
      players: [
        { playerId: 'p1', position: Positions.First, ready: true },
        { playerId: 'p2', position: Positions.Second, ready: true },
        { playerId: 'p3', position: Positions.Third, ready: true },
        { playerId: 'p4', position: Positions.Fourth, ready: false },
      ],
    });

    const result = patchPlayerReady(match, 'p4', true, fullDeck());

    expect(result.currentGame.id).toBe('unfinished-game');
  });
});

describe('placeBid', () => {
  it('rejects an illegal (insufficient) bid', () => {
    let match = baseMatch();
    match = placeBid(match, 'p1', Bid.Thirty);
    expect(match.currentGame.currentPlayerId).toBe('p2'); // advances since bidding isn't complete

    expect(() => placeBid(match, 'p2', Bid.Thirty)).toThrow(ValidationError);
    try {
      placeBid(match, 'p2', Bid.Thirty);
    } catch (e) {
      expect((e as ValidationError).title).toBe('Insufficient bid!');
    }
  });

  it("rejects a bid when it isn't the bidder's turn", () => {
    const match = baseMatch();
    expect(() => placeBid(match, 'p2', Bid.Thirty)).toThrow(ValidationError);
  });

  it('sets the Plunge bidder\'s partner as currentPlayerId once bidding completes', () => {
    let match = baseMatch();
    match = placeBid(match, 'p1', Bid.Pass);
    match = placeBid(match, 'p2', Bid.Pass);
    match = placeBid(match, 'p3', Bid.Plunge);
    match = placeBid(match, 'p4', Bid.Pass);

    expect(match.currentGame.bid).toBe(Bid.Plunge);
    expect(match.currentGame.biddingPlayerId).toBe('p3');
    // p3 is at Third(2); partner is Third+2 = First(0) = p1.
    expect(match.currentGame.currentPlayerId).toBe('p1');
  });

  it('sets currentPlayerId to the bidder once bidding completes with a non-Plunge winning bid', () => {
    let match = baseMatch();
    match = placeBid(match, 'p1', Bid.Thirty);
    match = placeBid(match, 'p2', Bid.Pass);
    match = placeBid(match, 'p3', Bid.Pass);
    match = placeBid(match, 'p4', Bid.Pass);

    expect(match.currentGame.biddingPlayerId).toBe('p1');
    expect(match.currentGame.currentPlayerId).toBe('p1');
  });

  it('everyone passing on the last bid is rejected (must have at least one real bid)', () => {
    let match = baseMatch();
    match = placeBid(match, 'p1', Bid.Pass);
    match = placeBid(match, 'p2', Bid.Pass);
    match = placeBid(match, 'p3', Bid.Pass);
    expect(() => placeBid(match, 'p4', Bid.Pass)).toThrow(ValidationError);
  });
});

describe('setTrump', () => {
  function readyToSetTrump(): MatchState {
    return baseMatch({
      currentGame: baseGame({
        bid: Bid.Thirty,
        biddingPlayerId: 'p1',
        currentPlayerId: 'p1',
        hands: [
          baseHand('p1', Teams.TeamA, { bid: Bid.Thirty }),
          baseHand('p2', Teams.TeamB, { bid: Bid.Pass }),
          baseHand('p3', Teams.TeamA, { bid: Bid.Pass }),
          baseHand('p4', Teams.TeamB, { bid: Bid.Pass }),
        ],
      }),
    });
  }

  it('first call wins: sets trump for the bidder', () => {
    const match = setTrump(readyToSetTrump(), 'p1', Suit.Sixes);
    expect(match.currentGame.trump).toBe(Suit.Sixes);
  });

  it('is a no-op once trump is already set (first call wins)', () => {
    let match = readyToSetTrump();
    match = setTrump(match, 'p1', Suit.Sixes);
    match = { ...match, currentGame: { ...match.currentGame, currentPlayerId: 'p1' } };
    match = setTrump(match, 'p1', Suit.Fives);
    expect(match.currentGame.trump).toBe(Suit.Sixes);
  });

  it('rejects a non-bidder trying to set trump', () => {
    const match = readyToSetTrump();
    expect(() => setTrump(match, 'p2', Suit.Sixes)).toThrow(ValidationError);
  });
});

describe('playDomino', () => {
  function readyToPlay(overrides: Partial<Game> = {}): MatchState {
    return baseMatch({
      currentGame: baseGame({
        bid: Bid.Thirty,
        biddingPlayerId: 'p1',
        trump: Suit.Sixes,
        currentPlayerId: 'p1',
        hands: [
          baseHand('p1', Teams.TeamA, { bid: Bid.Thirty, dominoes: [createDomino(6, 6), createDomino(1, 2)] }),
          baseHand('p2', Teams.TeamB, { bid: Bid.Pass, dominoes: [createDomino(6, 3), createDomino(0, 0)] }),
          baseHand('p3', Teams.TeamA, { bid: Bid.Pass, dominoes: [createDomino(6, 1), createDomino(2, 2)] }),
          baseHand('p4', Teams.TeamB, { bid: Bid.Pass, dominoes: [createDomino(6, 0), createDomino(3, 3)] }),
        ],
        ...overrides,
      }),
    });
  }

  it('throws when playing a domino the player does not hold', () => {
    const match = readyToPlay();
    expect(() => playDomino(match, 'p1', createDomino(5, 5))).toThrow(ValidationError);
  });

  it('rejects playing out of turn', () => {
    const match = readyToPlay();
    expect(() => playDomino(match, 'p2', createDomino(6, 3))).toThrow(ValidationError);
  });

  it('enforces following suit', () => {
    // p1 leads a Sixes domino, establishing trick suit Sixes. p2 holds a Sixes domino
    // (6/3) but tries to play a non-Sixes domino instead - must be rejected.
    let match = readyToPlay();
    match = playDomino(match, 'p1', createDomino(6, 6));
    expect(match.currentGame.currentPlayerId).toBe('p2');
    expect(match.currentGame.currentTrick.suit).toBe(Suit.Sixes);

    expect(() => playDomino(match, 'p2', createDomino(0, 0))).toThrow(ValidationError);
  });

  it('tracks the trick winner as the highest-suit-value domino played so far', () => {
    let match = readyToPlay();
    match = playDomino(match, 'p1', createDomino(6, 6)); // double-six, suit value 7 (trump double)
    expect(match.currentGame.currentTrick.playerId).toBe('p1');
    expect(match.currentGame.currentTrick.team).toBe(Teams.TeamA);

    match = playDomino(match, 'p2', createDomino(6, 3)); // suit value 3 (trump non-double) - doesn't beat 6/6
    expect(match.currentGame.currentTrick.playerId).toBe('p1');
  });

  // Regression test for IMPORTANT finding #7 from the final whole-branch review: playDomino used
  // to persist/broadcast whatever domino object the CALLER passed (straight from a client request
  // body), not the actual domino from the player's hand - so a client sending `{top, bottom}` with
  // no `id`, or extra/malformed fields, would have that exact object written to storage and
  // broadcast to every socket. Simulates that by passing a bare object missing `.id` and carrying
  // a bogus extra field.
  it('persists the ACTUAL domino from the hand (with its real id), not the raw request-body object', () => {
    const match = readyToPlay();
    const rawFromClient = { top: 6, bottom: 6, bogus: 'should not survive' } as unknown as Domino;

    const result = playDomino(match, 'p1', rawFromClient);

    const stored = result.currentGame.currentTrick.dominoes.find((d) => d !== null)!;
    expect(stored.id).toBe(createDomino(6, 6).id);
    expect(stored).not.toHaveProperty('bogus');
    expect(stored).toEqual(createDomino(6, 6));
  });

  it('completes a trick, advances currentPlayerId to the winner, and starts a fresh trick', () => {
    let match = readyToPlay();
    match = playDomino(match, 'p1', createDomino(6, 6)); // p1 wins so far
    match = playDomino(match, 'p2', createDomino(6, 3));
    match = playDomino(match, 'p3', createDomino(6, 1));
    match = playDomino(match, 'p4', createDomino(6, 0));

    expect(match.currentGame.tricks).toHaveLength(1);
    expect(match.currentGame.tricks[0].playerId).toBe('p1');
    expect(match.currentGame.currentPlayerId).toBe('p1'); // winner leads next
    expect(match.currentGame.currentTrick.dominoes).toEqual([null, null, null, null]);
  });
});

describe('matchScores', () => {
  it('sums each filed game\'s value per team, treating a null value as 0', () => {
    const match = baseMatch({
      games: {
        [Teams.TeamA]: [
          baseGame({ id: 'a1', biddingPlayerId: 'p1', hands: [baseHand('p1', Teams.TeamA, { bid: Bid.Thirty })] }),
          baseGame({ id: 'a2', biddingPlayerId: null }), // null value -> counts as 0
        ],
        [Teams.TeamB]: [
          baseGame({
            id: 'b1',
            biddingPlayerId: 'p2',
            hands: [baseHand('p2', Teams.TeamB, { bid: Bid.EightyFour })],
          }),
        ],
      },
    });

    expect(matchScores(match)).toEqual({ [Teams.TeamA]: 1, [Teams.TeamB]: 2 });
  });
});

describe('getPlayerView', () => {
  it('projects a narrow, per-player DTO rather than the full MatchState', () => {
    const match = baseMatch({
      currentGame: baseGame({
        currentPlayerId: 'p2',
        hands: [
          baseHand('p1', Teams.TeamA, { bid: Bid.Thirty }),
          baseHand('p2', Teams.TeamB, { dominoes: [createDomino(1, 2)], bid: Bid.Pass }),
          baseHand('p3', Teams.TeamA),
          baseHand('p4', Teams.TeamB),
        ],
      }),
      players: [
        { playerId: 'p1', position: Positions.First, ready: true },
        { playerId: 'p2', position: Positions.Second, ready: false },
        { playerId: 'p3', position: Positions.Third, ready: true },
        { playerId: 'p4', position: Positions.Fourth, ready: true },
      ],
    });

    expect(getPlayerView(match, 'p2')).toEqual({
      playerId: 'p2',
      team: Teams.TeamB, // position 1 (Second) -> odd -> TeamB, per teamForPosition
      isActive: true, // currentPlayerId === 'p2'
      ready: false,
      dominoes: [createDomino(1, 2)],
      bid: Bid.Pass,
    });
  });

  it('rejects a caller who is not a player in this match', () => {
    const match = baseMatch();
    expect(() => getPlayerView(match, 'not-a-player')).toThrow(ValidationError);
  });
});
