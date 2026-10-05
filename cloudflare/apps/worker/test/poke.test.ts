// pokeTarget and pokeTurnKey against matches built with the real rules engine.
import { describe, expect, it } from 'vitest';
import { Bid, createDomino, createMatch, placeBid, takeSeat, type Domino, type MatchState } from '@fortytwo/rules';
import { POKE_IDLE_MS, pokeTarget, pokeTurnKey } from '../src/poke';

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// p1-p3 seated; `last` takes the 4th seat, which deals.
function dealt(last = 'p4'): MatchState {
  let match = createMatch('p1');
  match = takeSeat(match, 'p2', 1);
  match = takeSeat(match, 'p3', 2);
  return takeSeat(match, last, 3, deck());
}

const idleSince = (match: MatchState) => Date.parse(match.updatedOn) + POKE_IDLE_MS;
const titleOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as { title?: string }).title;
  }
  return undefined;
};

describe('pokeTarget', () => {
  it('names the player whose turn it is once their turn has waited 30 minutes', () => {
    const match = dealt();
    const turn = match.currentGame.currentPlayerId!;
    const poker = ['p1', 'p2', 'p3', 'p4'].find((id) => id !== turn)!;

    expect(pokeTarget(match, poker, idleSince(match))).toBe(turn);
    expect(titleOf(() => pokeTarget(match, poker, idleSince(match) - 1))).toBe('Too soon to poke');
  });

  it("refuses someone who isn't seated, and the player whose turn it is", () => {
    const match = dealt();
    const turn = match.currentGame.currentPlayerId!;

    expect(titleOf(() => pokeTarget(match, 'p9', idleSince(match)))).toBe("You aren't a part of this match!");
    expect(titleOf(() => pokeTarget(match, turn, idleSince(match)))).toBe("It's your turn");
  });

  it('refuses before the hand is dealt', () => {
    const match = takeSeat(createMatch('p1'), 'p2', 1);
    expect(titleOf(() => pokeTarget(match, 'p2', idleSince(match)))).toBe('Nobody to poke');
  });

  it('refuses when the turn is a bot', () => {
    // Bidding starts left of the dealer and moves round the table, so some bid lands on bot-1.
    let match = dealt('bot-1');
    while (match.currentGame.currentPlayerId !== 'bot-1') match = placeBid(match, match.currentGame.currentPlayerId!, Bid.Pass);
    expect(titleOf(() => pokeTarget(match, 'p1', idleSince(match)))).toBe('Nobody to poke');
  });
});

describe('pokeTurnKey', () => {
  it('changes when the turn moves on', () => {
    const match = dealt();
    const next = placeBid(match, match.currentGame.currentPlayerId!, Bid.Pass);
    expect(pokeTurnKey(next)).not.toBe(pokeTurnKey(match));
  });
});
