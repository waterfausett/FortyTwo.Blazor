// The match summary dialog: who won, each team and its final marks, every hand played, and the way
// on - back to the lobby, or a rematch with the same four once everyone asks for one (or a link to
// it, once it exists). Opening a hand's row shows the dominoes I held for it. Opened from the
// scoreboard before the match is over, it's the match so far: the hands decided yet, and no way
// on. Everything here comes from the MatchState the page already holds.
import { Fragment, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import {
  Bid,
  Teams,
  bidToPrettyString,
  matchScores,
  rematchAgreed,
  suitToPrettyString,
  type Game,
  type MatchState,
} from '@fortytwo/rules';
import { marksToWin, playedHands, startingHand } from '@fortytwo/client';
import { Domino } from './Domino';
import { MatchOverActions } from './MatchOverActions';

interface MatchSummaryProps {
  match: MatchState;
  myPlayerId: string;
  myTeam: Teams;
  nameFor: (playerId: string | null) => string;
  iVoted: boolean;
  rematchDisabled: boolean;
  onRematch: () => void;
  onClose: () => void;
  // Set for a Live match: the sheet then offers Party up and Find a game beside Lobby and Rematch.
  live?: Omit<Parameters<typeof MatchOverActions>[0], 'layout' | 'rematch' | 'lobby'>;
}

function teamOf(position: number): Teams {
  return position % 2 === 0 ? Teams.TeamA : Teams.TeamB;
}

// The hand I held for one game, under its row: my bid, the trump, and the 7 dominoes - or a note
// when I took my seat after it was played.
function HeldHand({ match, game, myPlayerId }: { match: MatchState; game: Game; myPlayerId: string }): JSX.Element {
  const dominoes = startingHand(match, game, myPlayerId);
  if (dominoes == null) return <p className="match-summary-held-note">You weren't at the table for this hand.</p>;
  const myBid = game.hands.find((h) => h.playerId === myPlayerId)?.bid ?? null;
  const details = [
    myBid == null ? null : myBid === Bid.Pass ? 'You passed' : `You bid ${bidToPrettyString(myBid)}`,
    game.trump == null ? null : `${suitToPrettyString(game.trump)} trump`,
  ].filter((d): d is string => d != null);
  return (
    <>
      <p className="match-summary-held-note">{details.join(' · ')}</p>
      {/* Laid out like a dealt hand: four over three. */}
      <div className="match-summary-held-dominoes" aria-label={`Your hand: ${dominoes.map((d) => d.id).join(', ')}`}>
        {[dominoes.slice(0, 4), dominoes.slice(4)].map((row, index) => (
          <div key={index} className="match-summary-held-row">
            {row.map((d) => (
              <Domino key={d.id} top={d.top} bottom={d.bottom} />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

export function MatchSummary({
  match,
  myPlayerId,
  myTeam,
  nameFor,
  iVoted,
  rematchDisabled,
  onRematch,
  onClose,
  live,
}: MatchSummaryProps): JSX.Element {
  const theirTeam = myTeam === Teams.TeamA ? Teams.TeamB : Teams.TeamA;
  const scores = matchScores(match);
  const over = match.winningTeam != null;
  const title = !over ? 'The match so far' : match.winningTeam === myTeam ? 'You won the match' : 'They won the match';
  const hands = playedHands(match);
  const namesOn = (team: Teams) =>
    match.players
      .filter((p) => teamOf(p.position) === team)
      .map((p) => nameFor(p.playerId))
      .join(' & ');
  const agreed = rematchAgreed(match).length;
  const [openHandId, setOpenHandId] = useState<string | null>(null);

  const lobbyLink = (
    <Link to="/" className="btn btn-outline-secondary">
      Back to lobby
    </Link>
  );
  const rematchControl = match.rematchId ? (
    <Link to={`/match/${match.rematchId}`} className="action-button">
      Go to rematch
    </Link>
  ) : (
    <button
      type="button"
      className="action-button"
      disabled={iVoted || rematchDisabled || (live?.choices.rematchDisabled ?? false)}
      onClick={onRematch}
    >
      {iVoted ? `Waiting for rematch (${agreed} of 4)` : agreed > 0 ? `Rematch (${agreed} of 4)` : 'Rematch'}
    </button>
  );

  return (
    <div className="match-summary-backdrop">
      <div className="match-summary" role="dialog" aria-modal="true" aria-labelledby="match-summary-title">
        <button type="button" className="match-summary-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <h2 id="match-summary-title" className="match-summary-title">
          {title}
        </h2>
        {!over && <p className="match-summary-subtitle">First to {marksToWin(match)} marks</p>}

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
              {hands.length === 0 && (
                <tr>
                  <td colSpan={5} className="match-summary-held-note">
                    No hands decided yet.
                  </td>
                </tr>
              )}
              {hands.map(({ game, winner, made, marks }) => {
                const open = openHandId === game.id;
                const toggle = () => setOpenHandId(open ? null : game.id);
                return (
                  <Fragment key={game.id}>
                    <tr className={`match-summary-hand ${winner === myTeam ? 'hand-us' : 'hand-them'}`} onClick={toggle}>
                      <td>
                        <button
                          type="button"
                          className="match-summary-hand-toggle"
                          aria-expanded={open}
                          aria-controls={`held-${game.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle();
                          }}
                        >
                          <span className="match-summary-chevron" aria-hidden="true">
                            {open ? '▾' : '▸'}
                          </span>
                          {game.name}
                        </button>
                      </td>
                      <td>{nameFor(game.biddingPlayerId)}</td>
                      <td>{game.bid == null ? '' : bidToPrettyString(game.bid)}</td>
                      <td>{game.trump == null ? '' : suitToPrettyString(game.trump)}</td>
                      <td>
                        {made ? 'Made' : 'Set'} <span className="match-summary-hand-marks">+{marks}</span>
                      </td>
                    </tr>
                    {open && (
                      <tr id={`held-${game.id}`} className="match-summary-held">
                        <td colSpan={5}>
                          <HeldHand match={match} game={game} myPlayerId={myPlayerId} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        {!over ? null : live ? (
          <MatchOverActions
            {...live}
            layout="rows"
            lobby={lobbyLink}
            rematch={rematchControl}
          />
        ) : (
          <div className="match-summary-actions">
            {lobbyLink}
            {rematchControl}
          </div>
        )}
      </div>
    </div>
  );
}
