// The match-over dialog: who won, each team and its final marks, every hand played, and the way
// on - back to the lobby, or a rematch with the same four once everyone asks for one. Everything
// here comes from the MatchState the page already holds.
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import {
  Teams,
  bidToPrettyString,
  matchScores,
  rematchAgreed,
  suitToPrettyString,
  type MatchState,
} from '@fortytwo/rules';
import { playedHands } from '../match/summary';

interface MatchSummaryProps {
  match: MatchState;
  myTeam: Teams;
  nameFor: (playerId: string | null) => string;
  iVoted: boolean;
  rematchDisabled: boolean;
  onRematch: () => void;
  onClose: () => void;
}

function teamOf(position: number): Teams {
  return position % 2 === 0 ? Teams.TeamA : Teams.TeamB;
}

export function MatchSummary({
  match,
  myTeam,
  nameFor,
  iVoted,
  rematchDisabled,
  onRematch,
  onClose,
}: MatchSummaryProps): JSX.Element {
  const theirTeam = myTeam === Teams.TeamA ? Teams.TeamB : Teams.TeamA;
  const scores = matchScores(match);
  const title = match.winningTeam === myTeam ? 'You won the match' : 'They won the match';
  const namesOn = (team: Teams) =>
    match.players
      .filter((p) => teamOf(p.position) === team)
      .map((p) => nameFor(p.playerId))
      .join(' & ');
  const agreed = rematchAgreed(match).length;

  return (
    <div className="match-summary-backdrop">
      <div className="match-summary" role="dialog" aria-modal="true" aria-labelledby="match-summary-title">
        <button type="button" className="match-summary-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <h2 id="match-summary-title" className="match-summary-title">
          {title}
        </h2>

        <div className="match-summary-teams">
          <div className="match-summary-team match-summary-us">
            <span className="match-summary-names">{namesOn(myTeam)}</span>
            <span className="match-summary-marks" data-testid="final-marks-us">
              {scores[myTeam] ?? 0}
            </span>
          </div>
          <div className="match-summary-team match-summary-them">
            <span className="match-summary-names">{namesOn(theirTeam)}</span>
            <span className="match-summary-marks" data-testid="final-marks-them">
              {scores[theirTeam] ?? 0}
            </span>
          </div>
        </div>

        <div className="match-summary-hands">
          <table>
            <thead>
              <tr>
                <th scope="col">Hand</th>
                <th scope="col">Bidder</th>
                <th scope="col">Bid</th>
                <th scope="col">Trump</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {playedHands(match).map(({ game, winner, made, marks }) => (
                <tr key={game.id} className={winner === myTeam ? 'hand-us' : 'hand-them'}>
                  <td>{game.name}</td>
                  <td>{nameFor(game.biddingPlayerId)}</td>
                  <td>{game.bid == null ? '' : bidToPrettyString(game.bid)}</td>
                  <td>{game.trump == null ? '' : suitToPrettyString(game.trump)}</td>
                  <td>
                    {made ? 'Made' : 'Set'} <span className="match-summary-hand-marks">+{marks}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="match-summary-actions">
          <Link to="/" className="btn btn-outline-secondary">
            Back to lobby
          </Link>
          <button type="button" className="action-button" disabled={iVoted || rematchDisabled} onClick={onRematch}>
            {iVoted ? `Waiting for rematch (${agreed} of 4)` : agreed > 0 ? `Rematch (${agreed} of 4)` : 'Rematch'}
          </button>
        </div>
      </div>
    </div>
  );
}
