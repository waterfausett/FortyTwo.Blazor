import { Bid, Suit, Teams, createDomino, type Domino, type Game, type MatchState, type Positions, type Trick } from '@fortytwo/rules';

// A match one play from over: TeamA (seats 0 & 2) has 6 marks, and in the 7th hand (seat 0 bid 30,
// Sixes trump) TeamA holds 28 points. Seat 0 led the 6-6 to the last trick and seats 1-2 followed;
// seat 3 plays its last domino, 1-3, and the 6-6 takes the trick (and the 4-1's 5 count): 34
// points makes the bid, the 7th mark wins the match.
function trick(team: Teams, playerId: string, dominoes: Domino[]): Trick {
  return { playerId, team, suit: Suit.Sixes, dominoes: [...dominoes, ...Array(4 - dominoes.length).fill(null)] };
}

function filedHand(n: number, players: string[]): Game {
  return {
    id: `filed-${n}`, name: `Game ${n}`, firstActionBy: players[0], bid: Bid.Thirty, biddingPlayerId: players[0],
    trump: Suit.Sixes, currentPlayerId: null,
    hands: players.map((playerId, seat) => ({ playerId, team: seat % 2 === 0 ? Teams.TeamA : Teams.TeamB, dominoes: [], bid: seat === 0 ? Bid.Thirty : Bid.Pass })),
    currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] }, tricks: [],
  };
}

// `leadAfter`: a domino seat 0 still holds, to lead once the match is won (plays after the end are allowed).
export function almostWonMatch(id: string, players = ['p1', 'p2', 'p3', 'p4'], leadAfter?: Domino): MatchState {
  const [a, b] = players;
  const d = createDomino;
  return {
    id, createdOn: '2026-10-01T00:00:00.000Z', updatedOn: '2026-10-01T00:00:00.000Z', winningTeam: null,
    games: { [Teams.TeamA]: [1, 2, 3, 4, 5, 6].map((n) => filedHand(n, players)) },
    players: players.map((playerId, position) => ({ playerId, position: position as Positions, ready: true })),
    currentGame: {
      ...filedHand(7, players),
      id: 'current', currentPlayerId: players[3],
      hands: players.map((playerId, seat) => ({
        playerId, team: seat % 2 === 0 ? Teams.TeamA : Teams.TeamB,
        dominoes: seat === 3 ? [d(1, 3)] : seat === 0 && leadAfter ? [leadAfter] : [], bid: seat === 0 ? Bid.Thirty : Bid.Pass,
      })),
      tricks: [
        trick(Teams.TeamA, a, [d(5, 5)]), trick(Teams.TeamA, a, [d(6, 4)]), trick(Teams.TeamA, a, [d(5, 0)]),
        trick(Teams.TeamB, b, [d(0, 0)]), trick(Teams.TeamB, b, [d(1, 1)]), trick(Teams.TeamB, b, [d(2, 2)]),
      ],
      currentTrick: { playerId: a, team: Teams.TeamA, suit: Suit.Sixes, dominoes: [d(6, 6), d(4, 1), d(3, 3), null] },
    },
  };
}
