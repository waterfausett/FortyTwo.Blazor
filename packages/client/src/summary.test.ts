import { describe, expect, it } from 'vitest';
import {
  Bid,
  Suit,
  Teams,
  assertValidDomino,
  createDomino,
  createMatch,
  matchViewFor,
  placeBid,
  playDomino,
  setTrump,
  takeSeat,
  type Domino,
  type Game,
  type MatchState,
} from '@fortytwo/rules';
import { playedHands, startingHand } from './summary';

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

// Builds real hands with the rules engine and reads them back through matchViewFor, as a client
// would, so each starting hand can be checked against what was actually dealt.
function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// The full deck, with `first` dealt to position 0 and the rest in deck order after it.
function dealOrder(first: Domino[] = []): Domino[] {
  const ids = new Set(first.map((d) => d.id));
  return [...first, ...deck().filter((d) => !ids.has(d.id))];
}

// p2-p4 join in turn, taking `positions` (p1 created the match at 0).
function dealt(order: Domino[], positions = [1, 2, 3]): MatchState {
  let match = createMatch('p1');
  match = takeSeat(match, 'p2', positions[0]);
  match = takeSeat(match, 'p3', positions[1]);
  return takeSeat(match, 'p4', positions[2], order);
}

// Bids in turn (from p1), names trump, then plays the first legal domino each turn until the
// hand is decided and filed.
function playHand(match: MatchState, bids: Bid[], trump: Suit): MatchState {
  for (const bid of bids) match = placeBid(match, match.currentGame.currentPlayerId!, bid);
  const caller =
    match.currentGame.bid === Bid.Plunge ? match.currentGame.currentPlayerId! : match.currentGame.biddingPlayerId!;
  match = setTrump(match, caller, trump);
  while (Object.values(match.games).every((games) => !games?.length)) {
    const game = match.currentGame;
    const playerId = game.currentPlayerId!;
    const hand = game.hands.find((h) => h.playerId === playerId)!;
    const domino = hand.dominoes.find((d) => {
      try {
        assertValidDomino(game, playerId, d);
        return true;
      } catch {
        return false;
      }
    })!;
    match = playDomino(match, playerId, domino);
  }
  return match;
}

function filedGame(match: MatchState): Game {
  return Object.values(match.games).flatMap((games) => games ?? [])[0];
}

// What `viewer` sees of the filed hand's starting dominoes, as ids.
function startingIds(match: MatchState, viewer: string): string[] | null {
  const view = matchViewFor(match, viewer);
  return startingHand(view, filedGame(view), viewer)?.map((d) => d.id) ?? null;
}

function dealtIds(order: Domino[], position: number): string[] {
  return order
    .slice(position * 7, position * 7 + 7)
    .map((d) => d.id)
    .sort();
}

describe('startingHand', () => {
  it('rebuilds every seat once all 7 tricks are played', () => {
    // p1 holds every blank and bids them all, so the hand runs to the last trick.
    const order = dealOrder();
    const match = playHand(dealt(order), [Bid.EightyFour, Bid.Pass, Bid.Pass, Bid.Pass], Suit.Blanks);
    expect(filedGame(match).tricks).toHaveLength(7);

    ['p1', 'p2', 'p3', 'p4'].forEach((viewer, position) => {
      expect(startingIds(match, viewer)?.sort()).toEqual(dealtIds(order, position));
    });
  });

  it('adds back the unplayed dominoes when a set ends the hand early', () => {
    const order = dealOrder();
    const match = playHand(dealt(order), [Bid.EightyFour, Bid.Pass, Bid.Pass, Bid.Pass], Suit.Sixes);
    expect(filedGame(match).tricks.length).toBeLessThan(7);

    ['p1', 'p2', 'p3', 'p4'].forEach((viewer, position) => {
      expect(startingIds(match, viewer)?.sort()).toEqual(dealtIds(order, position));
    });
  });

  it('follows the partner leading on a Plunge', () => {
    const doubles = [0, 1, 2, 3, 4].map((n) => createDomino(n, n));
    const order = dealOrder([...doubles, createDomino(5, 6), createDomino(4, 6)]);
    const match = playHand(dealt(order), [Bid.Plunge, Bid.Pass, Bid.Pass, Bid.Pass], Suit.Fives);
    expect(filedGame(match).bid).toBe(Bid.Plunge);

    ['p1', 'p2', 'p3', 'p4'].forEach((viewer, position) => {
      expect(startingIds(match, viewer)?.sort()).toEqual(dealtIds(order, position));
    });
  });

  it("skips the bidder's partner on Low, who keeps all 7", () => {
    const order = dealOrder();
    const match = playHand(dealt(order), [Bid.FortyTwo, Bid.Pass, Bid.Pass, Bid.Pass], Suit.Low);
    expect(filedGame(match).tricks.length).toBeGreaterThan(0);

    ['p1', 'p2', 'p3', 'p4'].forEach((viewer, position) => {
      expect(startingIds(match, viewer)?.sort()).toEqual(dealtIds(order, position));
    });
    expect(filedGame(match).hands.find((h) => h.playerId === 'p3')!.dominoes).toHaveLength(7);
  });

  it("seats a game from before a takeover by the ids saved on it, not today's table", () => {
    // p2 bids and leads, then a newcomer takes p2's seat: p2 is now only in the saved game.
    const order = dealOrder();
    const played = playHand(dealt(order), [Bid.Pass, Bid.Thirty, Bid.Pass, Bid.Pass], Suit.Deuces);
    const match: MatchState = {
      ...played,
      players: played.players.map((p) => (p.playerId === 'p2' ? { ...p, playerId: 'p5' } : p)),
    };

    ['p1', 'p3', 'p4'].forEach((viewer) => {
      const position = played.players.find((p) => p.playerId === viewer)!.position;
      expect(startingIds(match, viewer)?.sort()).toEqual(dealtIds(order, position));
    });
    expect(startingIds(match, 'p5')).toBeNull();
  });

  it('places a pair who took over a whole team by where the saved hands were dealt', () => {
    // p2 sits at 3 and p4 at 1, so the first free seat on their team isn't p2's. Both leave to
    // newcomers; p4 bid, so its seat decides who leads.
    const order = dealOrder();
    const played = playHand(dealt(order, [3, 2, 1]), [Bid.Pass, Bid.Thirty, Bid.Pass, Bid.Pass], Suit.Deuces);
    expect(filedGame(played).biddingPlayerId).toBe('p4');
    const renamed: Record<string, string> = { p2: 'p6', p4: 'p5' };
    const match: MatchState = {
      ...played,
      players: played.players.map((p) => ({ ...p, playerId: renamed[p.playerId] ?? p.playerId })),
    };

    expect(startingIds(match, 'p1')?.sort()).toEqual(dealtIds(order, 0));
    expect(startingIds(match, 'p3')?.sort()).toEqual(dealtIds(order, 2));
  });

  it('has nothing for someone who held no hand in that game', () => {
    const match = playHand(dealt(dealOrder()), [Bid.Thirty, Bid.Pass, Bid.Pass, Bid.Pass], Suit.Sixes);
    expect(startingIds(match, 'watcher')).toBeNull();
  });

  it('lists the hand high to low', () => {
    const match = playHand(dealt(dealOrder()), [Bid.EightyFour, Bid.Pass, Bid.Pass, Bid.Pass], Suit.Blanks);
    expect(startingIds(match, 'p4')).toEqual(['6/6', '5/6', '4/6', '3/6', '5/5', '4/5', '4/4']);
  });
});
