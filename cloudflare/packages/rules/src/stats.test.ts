import { describe, it, expect } from 'vitest';
import { matchStatsFor, NO_TRUMPS, MIN_HANDS_FOR_RESULT } from './stats';
import { Bid } from './bid';
import { Suit } from './suit';
import { Teams } from './teams';
import type { Game } from './game';
import type { MatchState } from './matchEngine';
import type { Positions } from './positions';

// A filed hand: who bid what, and the team that took it. Only the fields stats read are real.
function hand(n: number, bidder: string, bidderTeam: Teams, bid: Bid, trump: Suit = Suit.Sixes): Game {
  return {
    id: `g${n}`,
    name: `Game ${n}`,
    firstActionBy: null,
    bid,
    biddingPlayerId: bidder,
    trump,
    currentPlayerId: null,
    hands: [{ playerId: bidder, team: bidderTeam, dominoes: [], bid }],
    currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
    tricks: [],
  };
}

function match(players: string[], games: MatchState['games'], winningTeam: Teams | null): MatchState {
  return {
    id: 'm1',
    createdOn: '2026-10-01T00:00:00.000Z',
    updatedOn: '2026-10-01T01:00:00.000Z',
    winningTeam,
    games,
    players: players.map((playerId, position) => ({ playerId, position: position as Positions, ready: true })),
    currentGame: hand(99, players[0], Teams.TeamA, Bid.Thirty),
  };
}

describe('matchStatsFor', () => {
  // Seats 0 & 2 are TeamA, 1 & 3 TeamB.
  const players = ['p1', 'p2', 'p3', 'p4'];

  it('is empty while the match is still being played', () => {
    expect(matchStatsFor(match(players, {}, null))).toEqual([]);
  });

  it('counts the result, marks and bids for each player', () => {
    const games: MatchState['games'] = {
      // TeamA: p1 made 30 and 34, p3 made 84 (2 marks); then set p2's Plunge (4 marks).
      [Teams.TeamA]: [
        hand(1, 'p1', Teams.TeamA, Bid.Thirty),
        hand(2, 'p1', Teams.TeamA, Bid.ThirtyFour),
        hand(3, 'p3', Teams.TeamA, Bid.EightyFour),
        hand(5, 'p2', Teams.TeamB, Bid.Plunge),
      ],
      // TeamB: set p1's 36.
      [Teams.TeamB]: [hand(4, 'p1', Teams.TeamA, Bid.ThirtySix)],
    };

    const stats = matchStatsFor(match(players, games, Teams.TeamA));

    expect(stats.find((s) => s.playerId === 'p1')).toEqual({
      playerId: 'p1',
      partnerId: 'p3',
      withBots: false,
      handsPlayed: 3,
      won: true,
      marksWon: 1 + 1 + 2 + 4,
      bidsWon: 3,
      bidsMade: 2,
      pointsBidTotal: 30 + 34 + 36,
      pointsBidCount: 3,
      marksBids: 0,
      trumps: { ...NO_TRUMPS, sixes: 3 },
    });
    expect(stats.find((s) => s.playerId === 'p3')).toMatchObject({ partnerId: 'p1', bidsWon: 1, bidsMade: 1, marksBids: 1, pointsBidCount: 0 });
    expect(stats.find((s) => s.playerId === 'p2')).toEqual({
      playerId: 'p2',
      partnerId: 'p4',
      withBots: false,
      handsPlayed: 1,
      won: false,
      marksWon: 1,
      bidsWon: 1,
      bidsMade: 0,
      pointsBidTotal: 0,
      pointsBidCount: 0,
      marksBids: 1,
      trumps: { ...NO_TRUMPS, sixes: 1 },
    });
  });

  it('counts 42 as both a points bid and a bid of a mark or more', () => {
    const games = { [Teams.TeamA]: [hand(1, 'p1', Teams.TeamA, Bid.FortyTwo), hand(2, 'p1', Teams.TeamA, Bid.FortyOne)] };
    expect(matchStatsFor(match(players, games, Teams.TeamA))[0]).toMatchObject({
      pointsBidTotal: 83,
      pointsBidCount: 2,
      marksBids: 1,
    });
  });

  it('counts the trump named on each winning bid, made or set, with every Low together', () => {
    const games = {
      [Teams.TeamA]: [
        hand(1, 'p1', Teams.TeamA, Bid.Thirty, Suit.Fives),
        hand(2, 'p1', Teams.TeamA, Bid.Thirty, Suit.None),
        hand(3, 'p1', Teams.TeamA, Bid.FortyTwo, Suit.Low),
        hand(4, 'p1', Teams.TeamA, Bid.FortyTwo, Suit.LowDoublesLow),
      ],
      [Teams.TeamB]: [hand(5, 'p1', Teams.TeamA, Bid.Thirty, Suit.Fives), hand(6, 'p2', Teams.TeamB, Bid.Thirty, Suit.Blanks)],
    };
    const stats = matchStatsFor(match(players, games, Teams.TeamA));
    expect(stats.find((s) => s.playerId === 'p1')?.trumps).toEqual({ ...NO_TRUMPS, fives: 2, followMe: 1, low: 2 });
    expect(stats.find((s) => s.playerId === 'p3')?.trumps).toEqual(NO_TRUMPS);
  });

  it('counts a made Low bid as made', () => {
    const games = { [Teams.TeamA]: [hand(1, 'p1', Teams.TeamA, Bid.FortyTwo, Suit.Low)] };
    expect(matchStatsFor(match(players, games, Teams.TeamA))[0]).toMatchObject({ bidsWon: 1, bidsMade: 1 });
  });

  it('gives bots no row and marks the humans as playing with bots', () => {
    const stats = matchStatsFor(match(['p1', 'bot-1', 'bot-2', 'bot-3'], {}, Teams.TeamB));
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ playerId: 'p1', partnerId: 'bot-2', withBots: true, won: false });
  });

  // p1 wins the bid in games 1, 2 and 4; hand 5 is p2's.
  const finishedGames = (): MatchState['games'] => ({
    [Teams.TeamA]: [hand(1, 'p1', Teams.TeamA, Bid.Thirty), hand(2, 'p1', Teams.TeamA, Bid.ThirtyFour), hand(5, 'p2', Teams.TeamB, Bid.Plunge)],
    [Teams.TeamB]: [hand(4, 'p1', Teams.TeamA, Bid.ThirtySix)],
  });
  const finished = (): MatchState => match(players, finishedGames(), Teams.TeamA);

  it('counts a match bots ever sat in as a bots game', () => {
    const rows = matchStatsFor({ ...finished(), hadBots: true });
    expect(rows.every((r) => r.withBots)).toBe(true);
  });

  it('counts the hands a player played, leaving out the ones a bot bid for them', () => {
    const m = finished();
    const first = m.games[Teams.TeamA]![0];
    const games = { ...m.games, [Teams.TeamA]: [{ ...first, hands: first.hands.map((h) => (h.playerId === 'p1' ? { ...h, autoBid: true as const } : h)) }, ...m.games[Teams.TeamA]!.slice(1)] };
    const filed = Object.values(m.games).reduce((n, gs) => n + (gs?.length ?? 0), 0);
    expect(filed).toBe(4);
    // The fixture files only each bidder's own hand, so p1 holds three of the four.
    expect(matchStatsFor(m).find((r) => r.playerId === 'p1')!.handsPlayed).toBe(3);
    const row = matchStatsFor({ ...m, games }).find((r) => r.playerId === 'p1')!;
    expect(row.handsPlayed).toBe(2);
    expect(MIN_HANDS_FOR_RESULT).toBe(3);
  });

  it("leaves a hand the bot bid for out of the player's bids", () => {
    const m = finished();
    const before = matchStatsFor(m).find((r) => r.playerId === 'p1')!;
    const games = Object.fromEntries(Object.entries(m.games).map(([team, gs]) => [team, gs!.map((g) =>
      g.biddingPlayerId === 'p1' ? { ...g, hands: g.hands.map((h) => (h.playerId === 'p1' ? { ...h, autoBid: true as const } : h)) } : g)]));
    const after = matchStatsFor({ ...m, games }).find((r) => r.playerId === 'p1')!;
    expect(before.bidsWon).toBe(3);
    expect(after.bidsWon).toBe(0);
  });
});
