// Builds real matches with the rules engine, then reads them the way a client would: through
// matchViewFor, so other players' hands arrive hidden as a count.
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
  type Trick,
} from '@fortytwo/rules';
import {
  bidTarget,
  describeMatch,
  isValidPlay,
  matchStatus,
  otherTeam,
  shouldStackTricks,
  teamTricksForDisplay,
} from './matchView';

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// p1..p4 at positions 0..3 (p1 & p3 are Team A), dealt from a fixed deck.
function dealtMatch(): MatchState {
  let match = createMatch('p1');
  match = takeSeat(match, 'p2', 1);
  match = takeSeat(match, 'p3', 2);
  match = takeSeat(match, 'p4', 3, deck());
  return match;
}

const names: Record<string, string> = { p1: 'Ann', p2: 'Bo', p3: 'Cy', p4: 'Di' };
const nameFor = (viewer: string) => (id: string | null) => (id === viewer ? 'You' : id ? names[id] : '');

// Everyone bids in turn: `high` bids `bid`, the rest pass.
function bidAround(match: MatchState, high: string, bid: Bid): MatchState {
  while (match.currentGame.hands.some((h) => h.bid == null)) {
    const turn = match.currentGame.currentPlayerId!;
    match = placeBid(match, turn, turn === high ? bid : Bid.Pass);
  }
  return match;
}

function view(match: MatchState, viewer: string) {
  const seen = matchViewFor(match, viewer);
  return { seen, view: describeMatch(seen, viewer) };
}

describe('describeMatch', () => {
  it('waits for four players before anything can happen', () => {
    let match = createMatch('p1');
    match = takeSeat(match, 'p2', 1);
    const { seen, view: v } = view(match, 'p1');

    expect(v.isTableReady).toBe(false);
    expect(v.canBid).toBe(false);
    expect(v.dealer).toBeNull();
    expect(matchStatus(seen, v, nameFor('p1'))).toBe('Waiting for players: 2 of 4 seated');
  });

  it('lets only the player whose turn it is bid', () => {
    const match = dealtMatch();
    const turn = match.currentGame.currentPlayerId!;
    const other = ['p1', 'p2', 'p3', 'p4'].find((p) => p !== turn)!;

    const mine = view(match, turn);
    expect(mine.view.isBiddingPhase).toBe(true);
    expect(mine.view.canBid).toBe(true);
    expect(matchStatus(mine.seen, mine.view, nameFor(turn))).toBe('You is bidding');

    const theirs = view(match, other);
    expect(theirs.view.canBid).toBe(false);
    expect(matchStatus(theirs.seen, theirs.view, nameFor(other))).toBe(`${names[turn]} is bidding`);
  });

  it('moves to trump selection for the high bidder once everyone has bid', () => {
    const match = bidAround(dealtMatch(), 'p2', Bid.Thirty);

    const bidder = view(match, 'p2');
    expect(bidder.view.isTrumpSelectPhase).toBe(true);
    expect(bidder.view.canSelectTrump).toBe(true);
    expect(bidder.view.bidderTeam).toBe(Teams.TeamB);
    expect(bidder.view.target).toBeNull();

    expect(view(match, 'p1').view.canSelectTrump).toBe(false);
  });

  it('gives the leader the first play and a point target to the bidders', () => {
    const match = setTrump(bidAround(dealtMatch(), 'p2', Bid.ThirtyTwo), 'p2', Suit.Fives);

    const leader = view(match, 'p2');
    expect(leader.view.isPlayingPhase).toBe(true);
    expect(leader.view.isMyTurnToPlay).toBe(true);
    expect(leader.view.target).toBe(32);
    expect(matchStatus(leader.seen, leader.view, nameFor('p2'))).toBe('Your lead');
    // Nothing led yet, so any domino may be played.
    expect(leader.view.me.dominoes!.every((d) => isValidPlay(leader.seen, leader.view, d))).toBe(true);
  });

  it('applies the follow-suit rule after a lead, and frees a player who already played', () => {
    const started = setTrump(bidAround(dealtMatch(), 'p2', Bid.ThirtyTwo), 'p2', Suit.Fives);
    const legalFor = (match: MatchState, playerId: string, domino: Domino) => {
      try {
        assertValidDomino(match.currentGame, playerId, domino);
        return true;
      } catch {
        return false;
      }
    };
    // Lead whichever domino leaves the next player both following and off-suit dominoes, so the
    // check below sees both answers.
    const next = started.players.find((p) => p.position === 2)!.playerId;
    const match = started.currentGame.hands
      .find((h) => h.playerId === 'p2')!
      .dominoes.map((lead) => playDomino(started, 'p2', lead))
      .find((m) => {
        const answers = m.currentGame.hands.find((h) => h.playerId === next)!.dominoes.map((d) => legalFor(m, next, d));
        return answers.includes(true) && answers.includes(false);
      })!;
    expect(match).toBeDefined();
    expect(match.currentGame.currentPlayerId).toBe(next);

    const follower = view(match, next);
    expect(matchStatus(follower.seen, follower.view, nameFor(next))).toBe('Your play');
    for (const domino of follower.view.me.dominoes!) {
      expect(isValidPlay(follower.seen, follower.view, domino)).toBe(legalFor(match, next, domino));
    }

    // The leader's next pick is for the following trick, so nothing is ruled out yet.
    const leader = view(match, 'p2');
    expect(leader.view.haveIPlayedInCurrentTrick).toBe(true);
    expect(leader.view.me.dominoes!.every((d) => isValidPlay(leader.seen, leader.view, d))).toBe(true);
  });

  it("sits the Low bidder's partner out", () => {
    const match = setTrump(bidAround(dealtMatch(), 'p1', Bid.FortyTwo), 'p1', Suit.Low);

    const partner = view(match, 'p3');
    expect(partner.view.isSittingOut).toBe(true);
    expect(partner.view.target).toBeNull();
    expect(matchStatus(partner.seen, partner.view, nameFor('p3'))).toBe(
      'Ann went Low and plays alone, so you sit this hand out. They need to lose every trick.'
    );
    expect(view(match, 'p2').view.isSittingOut).toBe(false);
  });
});

describe('helpers', () => {
  it('pairs each team with the other', () => {
    expect(otherTeam(Teams.TeamA)).toBe(Teams.TeamB);
    expect(otherTeam(Teams.TeamB)).toBe(Teams.TeamA);
  });

  it('targets 42 for any marks bid', () => {
    const match = setTrump(bidAround(dealtMatch(), 'p1', Bid.EightyFour), 'p1', Suit.Sixes);
    expect(bidTarget(match.currentGame)).toBe(42);
  });

  it('targets 42 for Plunge, not its stored value of 169', () => {
    const game = { bid: Bid.Plunge, trump: Suit.Sixes } as unknown as Game;
    expect(bidTarget(game)).toBe(42);
  });
});

describe('trick piles', () => {
  const trick = (team: Teams, n: number) => ({ playerId: `p${n}`, team, suit: null, dominoes: [] }) as unknown as Trick;
  const game = (bid: Bid | null, trump: Suit | null) => ({ bid, trump }) as unknown as Game;

  it('stacks only on bids past 42 that are neither Plunge nor Low', () => {
    expect(shouldStackTricks(game(Bid.FortyTwo, Suit.Sixes))).toBe(false);
    expect(shouldStackTricks(game(Bid.EightyFour, Suit.Sixes))).toBe(true);
    expect(shouldStackTricks(game(Bid.Plunge, Suit.Sixes))).toBe(false);
    expect(shouldStackTricks(game(Bid.EightyFour, Suit.Low))).toBe(false);
    expect(shouldStackTricks(game(null, null))).toBe(false);
  });

  it("shows a team's tricks in the order won, or only the last two when stacked", () => {
    const tricks = [trick(Teams.TeamA, 1), trick(Teams.TeamB, 2), trick(Teams.TeamA, 3), trick(Teams.TeamA, 4)];
    expect(teamTricksForDisplay(tricks, Teams.TeamA, false).map((t) => t.playerId)).toEqual(['p1', 'p3', 'p4']);
    expect(teamTricksForDisplay(tricks, Teams.TeamA, true).map((t) => t.playerId)).toEqual(['p3', 'p4']);
    expect(teamTricksForDisplay(tricks, Teams.TeamB, true).map((t) => t.playerId)).toEqual(['p2']);
  });
});
