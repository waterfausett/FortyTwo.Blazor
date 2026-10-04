// pokeTarget against real matches, read as a client gets them (matchViewFor).
import { describe, expect, it } from 'vitest';
import { Bid, createDomino, createMatch, matchViewFor, placeBid, takeSeat, type Domino, type MatchState } from '@fortytwo/rules';
import { POKE_IDLE_MS, isPokeCurrent, pokeTarget, pokeTurnKey, pokeableAt } from './poke';

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

function dealt(last = 'p4'): MatchState {
  let match = createMatch('p1');
  match = takeSeat(match, 'p2', 1);
  match = takeSeat(match, 'p3', 2);
  return takeSeat(match, last, 3, deck());
}

describe('pokeTarget', () => {
  it('names whoever the table is waiting on, for anyone else seated', () => {
    const match = dealt();
    const turn = match.currentGame.currentPlayerId!;
    const other = ['p1', 'p2', 'p3', 'p4'].find((id) => id !== turn)!;

    expect(pokeTarget(matchViewFor(match, other), other)).toBe(turn);
    expect(pokeTarget(matchViewFor(match, turn), turn)).toBeNull();
    expect(pokeTarget(matchViewFor(match, 'p9'), 'p9')).toBeNull();
  });

  it('is null before the deal and when the turn is a bot', () => {
    expect(pokeTarget(takeSeat(createMatch('p1'), 'p2', 1), 'p1')).toBeNull();

    let match = dealt('bot-1');
    while (match.currentGame.currentPlayerId !== 'bot-1') match = placeBid(match, match.currentGame.currentPlayerId!, Bid.Pass);
    expect(pokeTarget(match, 'p1')).toBeNull();
  });
});

describe('isPokeCurrent', () => {
  it('holds while the table is still waiting on me, and not once my turn has passed', () => {
    const match = dealt();
    const turn = match.currentGame.currentPlayerId!;

    expect(isPokeCurrent(matchViewFor(match, turn), turn)).toBe(true);
    const moved = placeBid(match, turn, Bid.Pass);
    expect(isPokeCurrent(matchViewFor(moved, turn), turn)).toBe(false);
    expect(isPokeCurrent(null, turn)).toBe(false);
  });
});

describe('pokeableAt and pokeTurnKey', () => {
  it('opens a turn to poking 30 minutes after it began, and names each turn afresh', () => {
    const match = dealt();
    expect(pokeableAt(match)).toBe(Date.parse(match.updatedOn) + POKE_IDLE_MS);

    const next = placeBid(match, match.currentGame.currentPlayerId!, Bid.Pass);
    expect(pokeTurnKey(next)).not.toBe(pokeTurnKey(match));
  });
});
