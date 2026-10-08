// pushNotices against matches built with the real rules engine.
import { describe, expect, it } from 'vitest';
import {
  Bid,
  Suit,
  Teams,
  gameValue,
  createDomino,
  createMatch,
  gameWinningTeam,
  placeBid,
  playDomino,
  setTrump,
  takeSeat,
  assertValidDomino,
  type Domino,
  type MatchState,
} from '@fortytwo/rules';
import { pushNotices, type Notice } from '../src/push/notices';

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// p1, p2 and p3 seated; the 4th seat goes to `last`.
function threeSeated(): MatchState {
  let match = createMatch('p1');
  match = takeSeat(match, 'p2', 1);
  return takeSeat(match, 'p3', 2);
}

const summary = (notices: Notice[]) => notices.map((n) => `${n.playerId}:${n.kind}:${n.headline}`).sort();

function legalPlay(match: MatchState): MatchState {
  const turn = match.currentGame.currentPlayerId!;
  const hand = match.currentGame.hands.find((h) => h.playerId === turn)!;
  const domino = hand.dominoes.find((d) => {
    try {
      assertValidDomino(match.currentGame, turn, d);
      return true;
    } catch {
      return false;
    }
  })!;
  return playDomino(match, turn, domino);
}

describe('pushNotices', () => {
  it('says the game is on when the last seat is taken, and tells the first bidder to bid', () => {
    const before = threeSeated();
    const after = takeSeat(before, 'p4', 3, deck());
    const first = after.currentGame.currentPlayerId!;

    const notices = pushNotices(before, after);
    expect(notices).toHaveLength(4);
    expect(notices.find((n) => n.playerId === first)).toMatchObject({ kind: 'turn', headline: 'Your bid' });
    expect(notices.filter((n) => n.kind === 'started').map((n) => n.headline)).toEqual(['Game on', 'Game on', 'Game on']);
    expect(notices.every((n) => n.matchId === after.id)).toBe(true);
    // Each carries the seats, so send.ts can name the match by its teams. The game on has no score
    // to tell (it's 0-0); the first bid does, like every other notice.
    expect(notices[0].players.map((p) => [p.playerId, p.position])).toEqual([
      ['p1', 0],
      ['p2', 1],
      ['p3', 2],
      ['p4', 3],
    ]);
    expect(notices.find((n) => n.kind === 'started')).toMatchObject({ detail: "All four seats are taken and we're ready to go!" });
    expect(notices.find((n) => n.kind === 'started')?.marks).toBeUndefined();
    expect(notices.find((n) => n.kind === 'turn')?.marks).toEqual({ [Teams.TeamA]: 0, [Teams.TeamB]: 0 });
  });

  it('leaves bots out', () => {
    const before = threeSeated();
    const after = takeSeat(before, 'bot-1', 3, deck());
    expect(notices(before, after).some((id) => id === 'bot-1')).toBe(false);

    function notices(a: MatchState, b: MatchState) {
      return pushNotices(a, b).map((n) => n.playerId);
    }
  });

  it('follows the turn round the table: bid, then naming trump, then play', () => {
    let match = takeSeat(threeSeated(), 'p4', 3, deck());
    const bidder = match.currentGame.currentPlayerId!;
    while (match.currentGame.hands.some((h) => h.bid == null)) {
      const turn = match.currentGame.currentPlayerId!;
      const next = placeBid(match, turn, turn === bidder ? Bid.Thirty : Bid.Pass);
      const notices = pushNotices(match, next);
      if (next.currentGame.hands.some((h) => h.bid == null)) {
        expect(summary(notices)).toEqual([`${next.currentGame.currentPlayerId}:turn:Your bid`]);
      } else {
        expect(summary(notices)).toEqual([`${bidder}:turn:Name trump`]);
      }
      match = next;
    }

    const trumped = setTrump(match, bidder, Suit.Sixes);
    // The bidder named trump and leads, so the turn didn't move: nobody else needs telling.
    expect(pushNotices(match, trumped)).toEqual([]);

    const led = legalPlay(trumped);
    expect(summary(pushNotices(trumped, led))).toEqual([`${led.currentGame.currentPlayerId}:turn:Your play`]);
  });

  it('says the hand is over once it is decided, and stops following the turn', () => {
    let match = takeSeat(threeSeated(), 'p4', 3, deck());
    const bidder = match.currentGame.currentPlayerId!;
    while (match.currentGame.hands.some((h) => h.bid == null)) {
      const turn = match.currentGame.currentPlayerId!;
      match = placeBid(match, turn, turn === bidder ? Bid.ThirtyFour : Bid.Pass);
    }
    match = setTrump(match, bidder, Suit.Sixes);

    let decidedBy: { before: MatchState; after: MatchState } | null = null;
    while (decidedBy === null && match.currentGame.tricks.length < 7) {
      const next = legalPlay(match);
      if (gameWinningTeam(next.currentGame) !== null) decidedBy = { before: match, after: next };
      match = next;
    }
    expect(decidedBy).not.toBeNull();
    const notices = pushNotices(decidedBy!.before, decidedBy!.after);
    expect(summary(notices)).toEqual(['p1:handOver:Hand over', 'p2:handOver:Hand over', 'p3:handOver:Hand over', 'p4:handOver:Hand over']);
    // The score counts the hand just decided.
    const after = decidedBy!.after;
    const winner = gameWinningTeam(after.currentGame)!;
    expect(notices[0].marks?.[winner]).toBe(gameValue(after.currentGame));
    expect(notices[0].detail).toBe('Ready up for the next hand.');
  });

  it("only tells a rematch's first bidder to bid", () => {
    const rematch = takeSeat(threeSeated(), 'p4', 3, deck());
    expect(summary(pushNotices(null, rematch))).toEqual([`${rematch.currentGame.currentPlayerId}:turn:Your bid`]);
  });

  it('has nothing to say while the table is filling', () => {
    const one = createMatch('p1');
    expect(pushNotices(null, one)).toEqual([]);
    expect(pushNotices(one, takeSeat(one, 'p2', 1))).toEqual([]);
  });
});
