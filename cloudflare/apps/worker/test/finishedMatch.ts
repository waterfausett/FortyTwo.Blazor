import { Positions, Teams, type MatchState } from '@fortytwo/rules';

// A match that just ended (TeamA reached 7), written straight into the DO's storage - playing a
// whole match through the RPCs would bury what these tests are about.
export function finishedMatch(
  id: string,
  playerIds = ['p1', 'p2', 'p3', 'p4'],
  winningTeam: Teams | null = Teams.TeamA
): MatchState {
  return {
    id,
    createdOn: '2026-01-01T00:00:00.000Z',
    updatedOn: '2026-01-01T00:00:00.000Z',
    winningTeam,
    games: {},
    players: playerIds.map((playerId, position) => ({ playerId, position: position as Positions, ready: false })),
    currentGame: {
      id: 'g9',
      name: 'Game 9',
      firstActionBy: playerIds[0],
      bid: null,
      biddingPlayerId: null,
      trump: null,
      currentPlayerId: playerIds[0],
      hands: playerIds.map((playerId, position) => ({
        playerId,
        team: position % 2 === 0 ? Teams.TeamA : Teams.TeamB,
        dominoes: [],
        bid: null,
      })),
      currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
      tricks: [],
    },
  };
}
