// Checks the projection against the rules engine itself: projecting a play from the view a client
// gets must match what the engine does once the server applies it.
import { describe, expect, it } from 'vitest';
import {
  Bid,
  Suit,
  ValidationError,
  createDomino,
  createMatch,
  matchViewFor,
  placeBid,
  playDomino,
  setTrump,
  takeSeat,
  type Domino,
  type MatchState,
} from '@fortytwo/rules';
import { assertPlayable, projectPlay } from './optimistic';

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

function playingMatch(): MatchState {
  let match = createMatch('p1');
  match = takeSeat(match, 'p2', 1);
  match = takeSeat(match, 'p3', 2);
  match = takeSeat(match, 'p4', 3, deck());
  while (match.currentGame.hands.some((h) => h.bid == null)) {
    const turn = match.currentGame.currentPlayerId!;
    match = placeBid(match, turn, turn === 'p2' ? Bid.ThirtyTwo : Bid.Pass);
  }
  return setTrump(match, 'p2', Suit.Fives);
}

const hand = (match: MatchState, playerId: string) => match.currentGame.hands.find((h) => h.playerId === playerId)!.dominoes;

// The first legal domino for whoever's turn it is.
function legalPlay(match: MatchState): Domino {
  const turn = match.currentGame.currentPlayerId!;
  return hand(match, turn).find((d) => {
    try {
      playDomino(match, turn, d);
      return true;
    } catch {
      return false;
    }
  })!;
}

describe('projectPlay', () => {
  it('matches the engine for each play of a trick, short of filing the trick that completes it', () => {
    let match = playingMatch();
    for (let i = 0; i < 4; i++) {
      const turn = match.currentGame.currentPlayerId!;
      const domino = legalPlay(match);
      const projected = projectPlay(matchViewFor(match, turn), turn, domino).currentGame;
      const actual = playDomino(match, turn, domino);

      expect(hand({ ...match, currentGame: projected }, turn)).toEqual(hand(matchViewFor(actual, turn), turn));
      if (i < 3) {
        expect(projected.currentTrick).toEqual(actual.currentGame.currentTrick);
        expect(projected.tricks).toEqual(actual.currentGame.tricks);
      } else {
        // Left on the table, full, until the server files it.
        expect(projected.currentTrick).toEqual(actual.currentGame.tricks.at(-1));
        expect(projected.tricks).toEqual(match.currentGame.tricks);
      }
      expect(projected.currentPlayerId).toBe(actual.currentGame.currentPlayerId);
      match = actual;
    }
  });
});

describe('assertPlayable', () => {
  it("throws the rules' own follow-suit error for a domino that doesn't follow", () => {
    const started = playingMatch();
    // Find a lead that leaves the next player holding both legal and illegal answers.
    for (const lead of hand(started, 'p2')) {
      const match = playDomino(started, 'p2', lead);
      const next = match.currentGame.currentPlayerId!;
      const seen = matchViewFor(match, next);
      const answers = hand(seen, next).map((d) => {
        try {
          assertPlayable(seen, next, d);
          return true;
        } catch (e) {
          expect(e).toBeInstanceOf(ValidationError);
          return false;
        }
      });
      if (answers.includes(true) && answers.includes(false)) return;
    }
    throw new Error('no lead gave a mix of legal and illegal answers');
  });
});
