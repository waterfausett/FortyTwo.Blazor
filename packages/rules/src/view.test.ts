import { describe, it, expect } from 'vitest';
import { createMatch, takeSeat, placeBid, setTrump, playDomino, MatchState } from './matchEngine';
import { createDomino, Domino } from './domino';
import { Bid } from './bid';
import { Suit } from './suit';
import { Teams } from './teams';
import { handSize, matchViewFor } from './view';

function fullDeck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// p1..p4 in seats 0-3, dealt from an unshuffled deck.
function dealtMatch(): MatchState {
  let match = createMatch('p1');
  match = takeSeat(match, 'p2', 1);
  match = takeSeat(match, 'p3', 2);
  return takeSeat(match, 'p4', 3, fullDeck());
}

function handOf(match: MatchState, playerId: string) {
  return match.currentGame.hands.find((h) => h.playerId === playerId)!;
}

describe('matchViewFor', () => {
  it("keeps the viewer's own hand", () => {
    const match = dealtMatch();

    const view = matchViewFor(match, 'p1');

    expect(handOf(view, 'p1').dominoes).toEqual(handOf(match, 'p1').dominoes);
  });

  it("hides everyone else's dominoes, leaving only how many they hold", () => {
    const view = matchViewFor(dealtMatch(), 'p1');

    for (const playerId of ['p2', 'p3', 'p4']) {
      const hand = handOf(view, playerId);
      expect(hand.dominoes).toEqual([]);
      expect(hand.hiddenCount).toBe(7);
      expect(handSize(hand)).toBe(7);
    }
  });

  it('hides every hand from someone who is not seated', () => {
    const view = matchViewFor(dealtMatch(), 'outsider');

    expect(view.currentGame.hands.every((h) => h.dominoes.length === 0 && h.hiddenCount === 7)).toBe(true);
  });

  it('keeps bids, team and the rest of the match as they are', () => {
    let match = dealtMatch();
    match = placeBid(match, 'p1', Bid.Thirty);

    const view = matchViewFor(match, 'p2');

    expect(handOf(view, 'p1')).toMatchObject({ bid: Bid.Thirty, team: Teams.TeamA });
    expect({ ...view, currentGame: { ...view.currentGame, hands: [] } }).toEqual({
      ...match,
      currentGame: { ...match.currentGame, hands: [] },
    });
  });

  // A decided hand is filed into `games` straight away but can still be played out, so the
  // filed copy holds the same unplayed dominoes the current game does.
  it('hides other hands in filed games too', () => {
    let match = dealtMatch();
    match = placeBid(match, 'p1', Bid.Thirty);
    for (const p of ['p2', 'p3', 'p4']) match = placeBid(match, p, Bid.Pass);
    match = setTrump(match, 'p1', Suit.Sixes);
    const filed = { ...match.currentGame };
    match = { ...match, games: { [Teams.TeamA]: [filed] } };

    const view = matchViewFor(match, 'p1');

    const filedView = view.games[Teams.TeamA]![0];
    expect(filedView.hands.find((h) => h.playerId === 'p1')!.dominoes).toHaveLength(7);
    expect(filedView.hands.find((h) => h.playerId === 'p2')!.dominoes).toEqual([]);
  });

  it('leaves an undealt hand showing zero', () => {
    const view = matchViewFor(createMatch('p1'), 'p2');

    expect(handSize(view.currentGame.hands[0])).toBe(0);
  });

  it('does not change the stored match', () => {
    const match = dealtMatch();
    const before = structuredClone(match);

    matchViewFor(match, 'p1');

    expect(match).toEqual(before);
  });
});

describe('handSize', () => {
  it('counts a visible hand by its dominoes', () => {
    let match = dealtMatch();
    match = placeBid(match, 'p1', Bid.Thirty);
    for (const p of ['p2', 'p3', 'p4']) match = placeBid(match, p, Bid.Pass);
    match = setTrump(match, 'p1', Suit.Sixes);
    match = playDomino(match, 'p1', handOf(match, 'p1').dominoes[0]);

    expect(handSize(handOf(match, 'p1'))).toBe(6);
  });
});
