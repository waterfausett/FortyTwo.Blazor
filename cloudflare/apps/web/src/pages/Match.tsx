// The match page: live bidding, trump selection, hand, and trick display. Replaces
// FortyTwo/Client/Pages/Match.razor(.cs) + Components/Domino.razor/RemotePlayer.razor/Chip.razor.
// Live state comes from `useMatchSocket` (Task 19's WebSocket hook, replacing the old app's
// SignalR `HubConnection`); actions (`bid`/`setTrump`/`playDomino`) are `apiClient()` mutations
// via TanStack Query's `useMutation`. Layout is `styles/match.css`, ported from
// `FortyTwo/Client/Pages/Match.razor.css` (a Blazor CSS-isolation scoped stylesheet Task 17's
// CSS port missed entirely, since it only identified/copied the 4 global stylesheets) plus
// Match.razor's own inline `<style>` block - see match.css's header comment for the full mapping.
//
// Scope note: this intentionally does NOT port the old page's "Ready Up!" between-games flow
// (`ApiClient.UpdateMatchPlayerAsync` / `readyUp`) - Task 20's brief interfaces section lists only
// `bid`/`setTrump`/`playDomino` as the mutations this page consumes, not `readyUp`, so that flow
// is left for whichever task actually owns it. It also doesn't port the old app's SweetAlert2
// toast/modal notifications for "next game started" / "match over" - the brief's own guidance is
// that a plain inline banner is sufficient for surfacing errors, and no equivalent visual-fanfare
// requirement is in scope here.
import type { JSX } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAuth0 } from '@auth0/auth0-react';
import { useParams } from 'react-router-dom';
import type { Domino as DominoType, Game } from '@fortytwo/rules';
import {
  Bid,
  Suit,
  Teams,
  bidToPrettyString,
  suitToPrettyString,
  getPlayerView,
  matchScores,
  trickValue,
} from '@fortytwo/rules';
import { apiClient } from '../api/client';
import { useMatchSocket } from '../api/useMatchSocket';
import { BiddingPanel } from '../components/BiddingPanel';
import { Hand } from '../components/Hand';
import { TrickDisplay } from '../components/TrickDisplay';
import '../styles/match.css';

// Every non-Low, non-None suit, in enum declaration order - the ordinary trump choices.
const NAMED_SUITS = [Suit.Blanks, Suit.Aces, Suit.Deuces, Suit.Threes, Suit.Fours, Suit.Fives, Suit.Sixes];
// "Follow Me" (no trump) and "Low" (lowest-domino-wins) are special trump choices the old app
// only offered for a big-enough bid (>= 42) - simplified here to always being offered, since
// Task 20's brief doesn't ask for that gating and the server (setTrump's validation) is the real
// authority regardless of what the client offers.
const ALL_TRUMP_CHOICES = [...NAMED_SUITS, Suit.None, Suit.Low];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function otherTeam(team: Teams): Teams {
  return team === Teams.TeamA ? Teams.TeamB : Teams.TeamA;
}

// The CURRENT GAME's cumulative point value of a team's already-COMPLETED tricks (i.e. NOT the
// trick still being played - that's TrickDisplay's job, and is a different, separate metric).
// Port of Match.razor:132/143's `teamTricks.Sum(x => x.Value)` where
// `teamTricks = CurrentGame.Tricks.Where(x => x.Team == team)`. `trickValue()` already includes
// the +1 base point per trick (trick.ts), so it isn't added again here.
function teamTrickPoints(game: Game, team: Teams): number {
  return game.tricks.filter((t) => t.team === team).reduce((sum, t) => sum + trickValue(t), 0);
}

// Minimal status for one of the other 3 seated players: their id (MatchState carries no Auth0
// display name for anyone but the calling user - an id-based label matches the real
// `MatchPlayer` entity's own scope, not a shortcut), a visual "their turn" indicator, and their
// remaining domino count. Deliberately reads only `hand.dominoes.length`, never the dominoes
// themselves, for a non-self hand - MatchState's wire shape happens to carry every hand's full
// contents unfiltered today (see Task 20's report), but a player-status display has no business
// showing another player's actual tiles regardless of what the wire currently allows.
function OtherPlayerStatus({ playerId, hand, isActive }: { playerId: string; hand: Game['hands'][number] | undefined; isActive: boolean }): JSX.Element {
  return (
    <div className={`player-remote${isActive ? ' active' : ''}`} data-testid="remote-player">
      <span className="player-remote-name">{playerId}</span>
      <span className="player-remote-dominoes">{hand?.dominoes.length ?? 0} dominoes</span>
    </div>
  );
}

export function Match(): JSX.Element {
  const { matchId } = useParams<{ matchId: string }>();
  const { user, getAccessTokenSilently } = useAuth0();
  const myPlayerId = user?.sub;

  const getToken = async (): Promise<string> => {
    const token = await getAccessTokenSilently();
    if (!token) throw new Error('Failed to obtain an access token.');
    return token;
  };

  const { match } = useMatchSocket(matchId ?? '', getToken);
  const client = apiClient(getToken);

  const bidMutation = useMutation({
    mutationFn: (bid: Bid) => client.bid(matchId!, bid),
  });
  const setTrumpMutation = useMutation({
    mutationFn: (suit: Suit) => client.setTrump(matchId!, suit),
  });
  const playMutation = useMutation({
    mutationFn: (domino: DominoType) => client.playDomino(matchId!, { top: domino.top, bottom: domino.bottom }),
  });

  const activeError = bidMutation.error ?? setTrumpMutation.error ?? playMutation.error;

  if (!matchId) {
    return (
      <p role="alert" className="match-error">
        No match specified.
      </p>
    );
  }

  if (!match || !myPlayerId) {
    return <div className="spinner" role="status" aria-label="Loading match" />;
  }

  if (!match.players.some((p) => p.playerId === myPlayerId)) {
    return (
      <p role="alert" className="match-error">
        You aren&apos;t a part of this match!
      </p>
    );
  }

  const game = match.currentGame;
  const me = getPlayerView(match, myPlayerId);
  const scores = matchScores(match);
  const opponentTeam = otherTeam(me.team);

  const isBiddingPhase = game.hands.some((h) => h.bid == null);
  const isTrumpSelectPhase = !isBiddingPhase && game.trump == null;
  const isPlayingPhase = !isBiddingPhase && game.trump != null;

  const canBid = isBiddingPhase && me.isActive;
  const canSelectTrump = isTrumpSelectPhase && me.isActive;
  const canPlay = isPlayingPhase && me.isActive && !playMutation.isPending;

  const myTrickPoints = teamTrickPoints(game, me.team);
  const opponentTrickPoints = teamTrickPoints(game, opponentTeam);

  const otherPlayers = match.players.filter((p) => p.playerId !== myPlayerId);

  return (
    <div className="match">
      {activeError != null && (
        <p role="alert" className="match-error">
          {errorMessage(activeError)}
        </p>
      )}

      <section className="team-scores" aria-label="Scores">
        <span>Us: {scores[me.team] ?? 0}</span>
        <span>Them: {scores[opponentTeam] ?? 0}</span>
        {match.winningTeam != null && (
          <span className="stamp">{match.winningTeam === me.team ? 'Winners!' : 'Game Over'}</span>
        )}
      </section>

      <div className="game-wrapper">
        <h5>{game.name}</h5>

        <div className="players-row" aria-label="Other players">
          {otherPlayers.map((p) => (
            <OtherPlayerStatus
              key={p.playerId}
              playerId={p.playerId}
              hand={game.hands.find((h) => h.playerId === p.playerId)}
              isActive={game.currentPlayerId === p.playerId}
            />
          ))}
        </div>

        <div className="gameboard">
          <div className="player-team-tricks">
            <span className="custom-chip custom-chip-info">
              Points
              <span className="badge badge-info">{myTrickPoints}</span>
            </span>
          </div>

          <TrickDisplay trick={game.currentTrick} trump={game.trump} />

          <div className="opponent-tricks">
            <span className="custom-chip custom-chip-info">
              Points
              <span className="badge badge-info">{opponentTrickPoints}</span>
            </span>
          </div>
        </div>

        <div className={`player p-2${me.isActive ? ' active' : ''}`}>
          {canBid && (
            <BiddingPanel
              game={game}
              myPlayerId={myPlayerId}
              onBid={(bid) => bidMutation.mutate(bid)}
              disabled={bidMutation.isPending}
            />
          )}

          {canSelectTrump && (
            <section className="trump-select-section" aria-label="Select trump">
              <p>Select a trump:</p>
              <div className="trump-options">
                {ALL_TRUMP_CHOICES.map((suit) => (
                  <button
                    key={suit}
                    type="button"
                    className="custom-chip custom-chip-info custom-chip-large"
                    disabled={setTrumpMutation.isPending}
                    onClick={() => setTrumpMutation.mutate(suit)}
                  >
                    {suitToPrettyString(suit)}
                  </button>
                ))}
              </div>
            </section>
          )}

          {(me.bid != null || game.trump != null) && (
            <div className="my-bid-trump">
              {me.bid != null && (
                <span className="custom-chip custom-chip-warning">
                  Bid
                  <span className="badge badge-warning">{bidToPrettyString(me.bid)}</span>
                </span>
              )}
              {game.trump != null && (
                <span className="custom-chip">
                  Trump
                  <span className="badge">{suitToPrettyString(game.trump)}</span>
                </span>
              )}
            </div>
          )}

          <Hand dominoes={me.dominoes ?? []} selectable={canPlay} onPlay={(domino) => playMutation.mutate(domino)} />
        </div>
      </div>
    </div>
  );
}
