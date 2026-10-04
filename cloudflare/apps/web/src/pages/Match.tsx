// The match page: live bidding, trump selection, hand, and trick display. Live state comes from
// `useMatchSocket`; actions (`bid`/`setTrump`/`playDomino`/`readyUp`) are `apiClient()` mutations
// via TanStack Query's `useMutation`. Layout is `styles/match.css`.
//
// Between hands, every player readies up (`readyUp`) - that's the only thing that deals the next
// hand once the current one has a winner (the very first hand deals on the 4th join). See the
// "Hand over" section below, gated on `gameWinningTeam(currentGame) !== null`. A decided hand can
// still be played out: play stays open until all 7 tricks are down, and the next hand deals as
// soon as all four players ready up, whether or not they finished playing.
//
// Rejected actions (an illegal play, a stale bid) pop a SweetAlert2 toast (ui/toast.ts). When the
// match ends, the hand-over rail offers a rematch and a summary dialog (components/MatchSummary.tsx)
// for anyone who wants it; a toast marks each new hand.
//
// Once the player whose turn it is has sat on it for 30 minutes, anyone else at the table gets a
// Poke button (match/usePoke.ts); a player poked while they have this page open gets a toast.
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth0 } from '@auth0/auth0-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Domino as DominoType, Trick } from '@fortytwo/rules';
import {
  Bid,
  Suit,
  bidToPrettyString,
  suitToPrettyString,
  matchScores,
  gameWinningTeam,
  handSize,
  isLow,
  lowDoublesToPrettyString,
  rematchAgreed,
  hasBeenDealt,
  isBot,
} from '@fortytwo/rules';
import { apiClient } from '../api/client';
import { useGetToken } from '../auth/useGetToken';
import { useMatchSocket } from '../api/useMatchSocket';
import { BiddingPanel } from '../components/BiddingPanel';
import { MatchSummary } from '../components/MatchSummary';
import { Hand } from '../components/Hand';
import { PipFace } from '../components/PipFace';
import { PlayDndContext, PlayDropZone } from '../components/PlayDnd';
import { TrumpPicker } from '../components/TrumpPicker';
import { Seat } from '../components/Seat';
import { SeatPicker } from '../components/SeatPicker';
import { TrickDisplay } from '../components/TrickDisplay';
import { TrickHistory } from '../components/TrickHistory';
import { toastError, toastInfo } from '../ui/toast';
import {
  MARKS_TO_WIN,
  assertPlayable,
  describeMatch,
  isHighBidder as holdsHighBid,
  isTrickStarted,
  isValidPlay as isLegalPlay,
  matchStatus,
  openSeats,
  projectPlay,
  seatFor,
  shouldStackTricks,
  teamTricksForDisplay,
  teamTrickPoints,
  trickLeaderId,
  trickPlayOrder,
} from '@fortytwo/client';
import type { Point } from '../match/sweep';
import { pileLandingPoint, readSweepMode, seatPoint, sweepDurationMs } from '../match/sweep';
import { usePoke } from '../match/usePoke';
import '../styles/match.css';

// How long a just-completed trick stays put in the center of the board (as if still "in
// progress") before it's swept off to its team's side pile - long enough to actually see what
// was played, instead of the trick vanishing the instant the last domino lands.
const TRICK_HOLD_MS = 1500;
// The tail end of that hold is the sweep (match/sweep.ts's `sweepDurationMs`), during which the
// trick leaves for the winning side rather than just blinking out.

// MARKS_TO_WIN (@fortytwo/client) marks win the match - drawn as a tally.
function MarkTally({ marks }: { marks: number }): JSX.Element {
  return (
    <span className="mark-tally" aria-hidden="true">
      {Array.from({ length: MARKS_TO_WIN }, (_, i) => (
        <span key={i} className={i < marks ? 'mark mark-won' : 'mark'} />
      ))}
    </span>
  );
}

export function Match(): JSX.Element {
  const { matchId } = useParams<{ matchId: string }>();
  const { user } = useAuth0();
  const myPlayerId = user?.sub;
  const getToken = useGetToken();

  // `reconnecting` means a socket closed on us - a live one dropped, or the first connect failed -
  // and the hook is retrying; the initial connect alone doesn't count. While down, the table may be
  // stale (a turn may already have passed), so the page says so and holds every action until the
  // socket is back.
  // What a poke needs when it lands, from state further down: the sender's display name, and
  // whether a move of mine is already in flight - then the poke is moot. (The Worker only sends a
  // poke while it's still my turn, and the socket keeps its messages in order, so that's the one
  // way one can land late.)
  const pokedRef = useRef<{ names?: Map<string, string>; moving: boolean }>({ moving: false });
  const { match: socketMatch, connected, reconnecting, deleted } = useMatchSocket(matchId ?? '', getToken, (from) => {
    if (pokedRef.current.moving) return;
    toastInfo(`${pokedRef.current.names?.get(from) ?? from} poked you`, "It's your turn", 'center');
  });
  const client = apiClient(getToken);

  // Initial load + reconnect-catchup: `useMatchSocket` starts at `null` and only fills once a
  // WebSocket message arrives (now sent immediately on connect - see matchDO.ts's post-upgrade
  // push - but a real network round-trip still takes a moment, and the very first render always
  // has no socket state yet). This REST fetch seeds/refreshes that gap so the page never sits on
  // an indefinite spinner: the match creator waiting for others to join, anyone reloading mid-game,
  // or a player reloading on their own turn (where nobody else's action would ever "unstick" them)
  // all get real state on first paint instead of waiting for a socket message that may never come.
  const matchQuery = useQuery({
    queryKey: ['match', matchId],
    queryFn: () => client.getMatch(matchId!),
    enabled: !!matchId,
    // A match that doesn't exist (deleted, or a stale link) won't appear on a retry - say so now.
    retry: (failureCount, error) => (error as { status?: number }).status !== 404 && failureCount < 3,
  });

  // Prefer the socket's state once it has ANY value (it's the live source of truth once connected);
  // fall back to the REST query's data before that (first paint, or while the socket is still
  // (re)connecting).
  const liveMatch = socketMatch ?? matchQuery.data ?? null;

  // Display names for everyone seated. Keyed on the sorted id list so it refetches only when
  // someone joins, not on every broadcast. Until it resolves (or if it fails), and for bots, which
  // have no Auth0 account, `nameFor` below falls back to the raw player id.
  const seatedIds = (liveMatch?.players.map((p) => p.playerId) ?? []).sort();
  const namesQuery = useQuery({
    queryKey: ['playerNames', seatedIds],
    queryFn: async () => {
      const users = await client.searchUsers(seatedIds);
      return new Map(users.map((u) => [u.user_id, u.displayName]));
    },
    enabled: seatedIds.length > 0,
    staleTime: Infinity,
  });

  const poke = usePoke(liveMatch, myPlayerId, () => client.poke(matchId!), (id) => namesQuery.data?.get(id) ?? id);

  const bidMutation = useMutation({
    mutationFn: (bid: Bid) => client.bid(matchId!, bid),
    onError: toastError,
  });
  const setTrumpMutation = useMutation({
    mutationFn: (suit: Suit) => client.setTrump(matchId!, suit),
    onError: toastError,
  });
  // Plays are optimistic: a legal play shows on the table the moment it's made, and the page
  // shows the match as it will be once the play lands (@fortytwo/client's projectPlay) until a
  // broadcast shows the domino gone from my hand. If the play is turned away, the domino goes back
  // to its place in my hand. Waiting for that broadcast, not just the request, also keeps a
  // second play from going out before the first has landed: the REST response arrives before the
  // broadcast, and `match` only ever updates from the broadcast. (Not "until the turn changes":
  // whoever wins the trick they complete leads the next one, so the turn can stay with me.)
  const [playing, setPlaying] = useState<DominoType | null>(null);
  const playMutation = useMutation({
    mutationFn: (domino: DominoType) => client.playDomino(matchId!, { top: domino.top, bottom: domino.bottom }),
    onError: (error) => {
      setPlaying(null);
      toastError(error);
    },
  });
  // Taking a seat from this page - opened from an invite link, say. The match's broadcast then
  // seats the player here; the lobby's lists change too.
  const queryClient = useQueryClient();
  const joinMutation = useMutation({
    mutationFn: (position: number) => client.joinMatch(matchId!, position),
    onSuccess: (joined) => {
      queryClient.setQueryData(['match', matchId], joined);
      void queryClient.invalidateQueries({ queryKey: ['matches'] });
    },
    onError: toastError,
  });
  const readyUpMutation = useMutation({
    mutationFn: () => client.readyUp(matchId!, true),
    onError: toastError,
  });
  const rematchMutation = useMutation({
    mutationFn: () => client.rematch(matchId!),
    onError: toastError,
  });
  // The summary only opens when asked for, from the rail's button: the end of the match plays out
  // on the table like any other hand.
  const [summaryOpen, setSummaryOpen] = useState(false);
  const navigate = useNavigate();
  // The player's own settings - here, whether to outline their playable dominoes. Shared with the
  // profile page's query, so a change saved there shows up here.
  const profileQuery = useQuery({ queryKey: ['profile'], queryFn: () => client.getProfile(), staleTime: Infinity });
  const highlightPlayable = profileQuery.data?.highlightPlayable ?? false;
  // Bots are a dev-only testing aid (the Worker's AUTO_PLAY_BOTS), so the controls for them only
  // show when the Worker says they're available.
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: Infinity });
  const botsEnabled = configQuery.data?.bots ?? false;
  // No position fills every open seat.
  const addBotsMutation = useMutation({
    mutationFn: (position?: number) => client.addBots(matchId!, position),
    onError: toastError,
  });

  // Set (by the button, before the request goes out) while this player's own leave is in flight:
  // if it deletes the match, their socket gets the same "deleted" close as everyone else's, and
  // they shouldn't be told about it.
  const leavingRef = useRef(false);
  const leaveMutation = useMutation({
    mutationFn: () => client.leaveMatch(matchId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['matches'] });
      navigate('/');
    },
    onError: (error) => {
      leavingRef.current = false;
      toastError(error);
    },
  });

  // The match was deleted (its last human left, or it expired) - there's nothing left to show.
  // Re-checked when this player's own leave fails, since by then the match may be gone anyway.
  const leaveFailed = leaveMutation.isError;
  useEffect(() => {
    if (!deleted || leavingRef.current) return;
    toastInfo('This match was deleted');
    void queryClient.invalidateQueries({ queryKey: ['matches'] });
    navigate('/', { replace: true });
  }, [deleted, leaveFailed, navigate, queryClient]);

  // Trick-hold state: `revealedTrickCount` is how many of `game.tricks` have finished their hold
  // (see TRICK_HOLD_MS above) and are allowed to appear in the side piles/point totals. Any trick
  // past that count is still being shown center-board - `heldTrick` below. Derived from
  // `match?.currentGame` rather than the `game` constant below since hooks must run
  // unconditionally, ahead of this function's early-return guards.
  const holdGame = liveMatch?.currentGame ?? null;
  const [isSweeping, setIsSweeping] = useState(false);
  const [sweepMode] = useState(() => readSweepMode());
  const matchRootRef = useRef<HTMLDivElement>(null);
  const [revealedTrickCount, setRevealedTrickCount] = useState(holdGame?.tricks.length ?? 0);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sweepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastGameIdRef = useRef(holdGame?.id ?? null);

  useEffect(() => {
    if (!holdGame) return;

    // A new hand was just dealt - drop any hold left over from the previous hand's last trick so
    // it can't fire against this hand's (unrelated) trick count.
    if (lastGameIdRef.current !== holdGame.id) {
      lastGameIdRef.current = holdGame.id;
      if (holdTimerRef.current != null) clearTimeout(holdTimerRef.current);
      if (sweepTimerRef.current != null) clearTimeout(sweepTimerRef.current);
      holdTimerRef.current = null;
      sweepTimerRef.current = null;
      setIsSweeping(false);
      setRevealedTrickCount(holdGame.tricks.length);
      return;
    }

    if (holdGame.tricks.length > revealedTrickCount && holdTimerRef.current == null) {
      const revealAt = holdGame.tricks.length;
      sweepTimerRef.current = setTimeout(() => {
        sweepTimerRef.current = null;
        setIsSweeping(true);
      }, TRICK_HOLD_MS - sweepDurationMs(sweepMode));
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        setIsSweeping(false);
        setRevealedTrickCount(revealAt);
      }, TRICK_HOLD_MS);
    }
  }, [holdGame, revealedTrickCount, sweepMode]);

  // The just-completed trick, while its hold runs. Worked out during render rather than stored by
  // the effect above: the broadcast that completes a trick also empties `currentTrick`, so waiting
  // for an effect would render one frame of an empty table in between - unmounting every tile and
  // replaying each one's fly-in animation when the held trick then remounted them. A new hand
  // starts with no tricks, so a stale `revealedTrickCount` from the last hand can't match here.
  const heldTrick: Trick | null =
    holdGame && holdGame.tricks.length > revealedTrickCount ? holdGame.tricks[holdGame.tricks.length - 1] : null;

  // Clear any in-flight hold timer on unmount (e.g. navigating away mid-hold) so it doesn't fire
  // a state update against an unmounted component.
  useEffect(() => {
    return () => {
      if (holdTimerRef.current != null) clearTimeout(holdTimerRef.current);
      if (sweepTimerRef.current != null) clearTimeout(sweepTimerRef.current);
    };
  }, []);

  // My hand as the server last sent it, and the play in flight while that hand still holds it.
  useEffect(() => {
    pokedRef.current = {
      names: namesQuery.data,
      moving: playing != null || bidMutation.isPending || setTrumpMutation.isPending,
    };
  }, [namesQuery.data, playing, bidMutation.isPending, setTrumpMutation.isPending]);

  const myLiveHand = holdGame?.hands.find((h) => h.playerId === myPlayerId)?.dominoes ?? [];
  const inFlight = playing != null && myLiveHand.some((d) => d.id === playing.id) ? playing : null;
  useEffect(() => {
    if (playing != null && inFlight == null) setPlaying(null);
  }, [playing, inFlight]);

  // Everyone asked for a rematch and it now exists (MatchDO creates it before recording the id),
  // so take this player there - but only when that happens while they're on the page. A match
  // whose rematch already existed when the page opened (from Game History, or Back from the
  // rematch) stays put and links to it instead; following it then would make the finished match
  // unviewable and trap the Back button. `replace` keeps the finished match out of history for
  // the same reason. MatchRoute keys the page by match id, so the rematch starts fresh.
  const rematchId = liveMatch?.rematchId;
  const rematchIdAtLoadRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!liveMatch) return;
    if (rematchIdAtLoadRef.current === undefined) {
      rematchIdAtLoadRef.current = rematchId ?? null;
      return;
    }
    if (rematchId && rematchId !== rematchIdAtLoadRef.current) navigate(`/match/${rematchId}`, { replace: true });
  }, [liveMatch, rematchId, navigate]);

  // A cue that the next hand is out, for anyone who readied up and looked away: bidding has
  // started without them. Only on a change of hand - never for the one the page opened on.
  const dealtGame = liveMatch?.currentGame ?? null;
  const seenGameIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!dealtGame) return;
    const previousId = seenGameIdRef.current;
    seenGameIdRef.current = dealtGame.id;
    if (previousId === null || previousId === dealtGame.id) return;
    const opener = dealtGame.firstActionBy;
    const who =
      opener === myPlayerId ? 'You bid first' : `${(opener && namesQuery.data?.get(opener)) ?? opener} bids first`;
    toastInfo(`${dealtGame.name} dealt`, who, 'center');
  }, [dealtGame, myPlayerId, namesQuery.data]);

  if (!matchId) {
    return (
      <p role="alert" className="match-error">
        No match specified.
      </p>
    );
  }

  // A match that can't be loaded - most often one that was deleted - says so rather than leaving
  // the loading spinner up forever.
  if (!liveMatch && matchQuery.isError) {
    return (
      <div role="alert" className="match-error">
        <p>{matchQuery.error.message}</p>
        <Link to="/">Back to lobby</Link>
      </div>
    );
  }

  if (!liveMatch || !myPlayerId) {
    return <div className="spinner" role="status" aria-label="Loading match" />;
  }

  // Someone who isn't seated - typically arriving from an invite link - picks a seat, or learns
  // the match is full.
  if (!liveMatch.players.some((p) => p.playerId === myPlayerId)) {
    // Having just left, the table's broadcast without this player usually arrives before the
    // leave's own reply navigates away - that's not a seat picker to show them.
    if (leaveMutation.isPending || leaveMutation.isSuccess) {
      return <div className="spinner" role="status" aria-label="Leaving match" />;
    }
    const seats = [0, 1, 2, 3].map((position) => {
      const player = liveMatch.players.find((p) => p.position === position);
      return player ? (namesQuery.data?.get(player.playerId) ?? player.playerId) : null;
    });
    const open = seats.some((name) => name == null);
    return (
      <section className="match-join mat-panel" aria-label="Join this match">
        <h1 className="match-join-title">{open ? 'Pick a seat to join' : 'This match is full'}</h1>
        {open ? (
          <SeatPicker seats={seats} disabled={joinMutation.isPending} onPick={(position) => joinMutation.mutate(position)} />
        ) : (
          <p className="match-join-note">All four seats are taken.</p>
        )}
        <Link to="/" className="match-join-back">
          Back to matches
        </Link>
      </section>
    );
  }

  // Everything below reads the match as it will be once a play in flight lands.
  const match = inFlight ? projectPlay(liveMatch, myPlayerId, inFlight) : liveMatch;
  const game = match.currentGame;
  // The phase of the hand, what I can do, and how the hand and match stand: @fortytwo/client's
  // matchView.ts, shared with the mobile app.
  const view = describeMatch(match, myPlayerId);
  const {
    me,
    opponentTeam,
    isTableReady,
    isBiddingPhase,
    isPlayingPhase,
    canBid,
    canSelectTrump,
    isHandOver,
    isHandPlayedOut,
    isSittingOut,
    iAmReady,
    readyCount,
    iVotedRematch,
  } = view;
  const scores = matchScores(match);
  const canPlay = view.isMyTurnToPlay && connected && playing == null;
  // Leaving deletes the match when nobody else human is seated, so the button says so.
  const onlyHumanSeated = match.players.every((p) => p.playerId === myPlayerId || isBot(p.playerId));

  // "Revealed" tricks are the ones the hold delay has let move to the side piles - `game.tricks`
  // itself always reflects the true, immediate server state (used above for e.g. `isHandOver`,
  // which must never lag behind the real rules), but the side piles/point badges intentionally
  // lag by up to TRICK_HOLD_MS while the just-completed trick is still shown center-board.
  const revealedTricks = game.tricks.slice(0, revealedTrickCount);
  const stackTricks = shouldStackTricks(game);
  const myTricks = teamTricksForDisplay(revealedTricks, me.team, stackTricks);
  const opponentTricks = teamTricksForDisplay(revealedTricks, opponentTeam, stackTricks);
  const myTrickPoints = teamTrickPoints(revealedTricks, me.team);
  const opponentTrickPoints = teamTrickPoints(revealedTricks, opponentTeam);
  const displayedTrick = heldTrick ?? game.currentTrick;
  // The hand-over panel waits for the deciding trick to finish its hold, like the side piles do,
  // so the result isn't announced while that trick is still on the table.
  const showHandOver = isHandOver && gameWinningTeam({ ...game, tricks: revealedTricks }) !== null;

  // Table geometry for the trick in the middle: who led it and which seat played each slot (so
  // every domino lands in front of whoever played it). A held trick is the last completed one.
  const displayedTrickIndex = heldTrick ? game.tricks.length - 1 : game.tricks.length;
  const trickLeader = isPlayingPhase ? trickLeaderId(match.players, game, displayedTrickIndex) : null;
  const trickOrder = trickPlayOrder(match.players, game, trickLeader);
  const trickSlotSeats = trickOrder.map((id) => (id == null ? null : seatFor(match.players, myPlayerId, id)));
  const winningSlot = displayedTrick.playerId == null ? null : trickOrder.indexOf(displayedTrick.playerId);
  const sweepTo = heldTrick && isSweeping ? (heldTrick.team === me.team ? 'us' : 'them') : null;
  const winnerSeat = winningSlot == null ? null : (trickSlotSeats[winningSlot] ?? null);
  const sweepTarget = (): Point | null => {
    const root = matchRootRef.current;
    if (!root || !sweepTo) return null;
    if (sweepMode === 'seat') return winnerSeat ? seatPoint(root, winnerSeat) : null;
    return pileLandingPoint(root, sweepTo);
  };

  const { dealer, bidderTeam, target, handWinner, isMatchOver } = view;

  const nameFor = (playerId: string | null): string =>
    playerId === myPlayerId ? 'You' : playerId == null ? '' : (namesQuery.data?.get(playerId) ?? playerId);

  // The markers every seat plate (mine included) shows, keyed off a player id.
  function seatPropsFor(playerId: string) {
    const player = match!.players.find((p) => p.playerId === playerId);
    const hand = game.hands.find((h) => h.playerId === playerId);
    const isHighBidder = holdsHighBid(game, playerId);
    // While bidding is open everyone's bid (Pass included) shows; once trump is named only the
    // winning bidder's does, alongside the trump they named.
    const bid = game.trump == null ? (hand?.bid ?? null) : isHighBidder ? game.bid : null;
    return {
      name: nameFor(playerId),
      side: player && player.position % 2 === myPosition % 2 ? ('us' as const) : ('them' as const),
      isActive: isTableReady && !isHandPlayedOut && game.currentPlayerId === playerId,
      isDealer: dealer === playerId,
      // Once the lead domino is down it carries its own "Lead" tag on the table, so the seat only
      // flags who is about to lead.
      isLeader: trickLeader === playerId && !isHandPlayedOut && !isTrickStarted(displayedTrick),
      bid: isTableReady ? bid : null,
      isHighBidder,
      trump: game.trump,
      ready: showHandOver && !isMatchOver ? (player?.ready ?? false) : null,
    };
  }

  const myPosition = match.players.find((p) => p.playerId === myPlayerId)!.position;
  const seatedOthers = match.players
    .filter((p) => p.playerId !== myPlayerId)
    .map((p) => ({ player: p, seat: seatFor(match.players, myPlayerId, p.playerId)! }));
  const emptySeats = openSeats(match.players, myPlayerId);

  // One line on the rail saying what the table is waiting on.
  const status = matchStatus(match, view, nameFor);

  // Gates which dominoes Hand will let a player preselect (double-click before their turn): only a
  // play that's legal right now, by the same follow-suit rule the server enforces.
  function isValidPlay(domino: DominoType): boolean {
    return isLegalPlay(match, view, domino);
  }

  // Checked here first, by the same rule the server applies, so an illegal play never leaves the
  // hand: it's refused at once with the rule's toast, and nothing is sent. A legal one leaves for
  // the table straight away.
  function playDomino(domino: DominoType): void {
    try {
      assertPlayable(liveMatch!, myPlayerId!, domino);
    } catch (error) {
      toastError(error);
      return;
    }
    setPlaying(domino);
    playMutation.mutate(domino);
  }

  return (
    <div ref={matchRootRef} className="match">
      {reconnecting && (
        <p className="match-reconnecting" role="status" aria-label="Reconnecting">
          Reconnecting…
        </p>
      )}
      <header className="scoreboard" aria-label="Scores">
        <div className="score score-us">
          <span className="score-label">Us</span>
          <span className="score-value">{scores[me.team] ?? 0}</span>
          <MarkTally marks={scores[me.team] ?? 0} />
        </div>

        <div className="contract">
          <span className="contract-game">{game.name}</span>
          {game.bid != null && game.bid !== Bid.Pass && game.biddingPlayerId != null ? (
            <span className={`contract-bid contract-${bidderTeam === me.team ? 'us' : 'them'}`}>
              <span className="contract-label">{game.trump == null ? 'High bid' : 'Bid'}</span>
              <span className="contract-value">{bidToPrettyString(game.bid)}</span>
              <span className="contract-by">{nameFor(game.biddingPlayerId)}</span>
            </span>
          ) : (
            isBiddingPhase && <span className="contract-bid contract-open">Bidding is open</span>
          )}
          {game.trump != null && (
            <span className="contract-trump">
              <span className="contract-label">Trump</span>
              <PipFace suit={game.trump} />
              <span className="contract-trump-name">{suitToPrettyString(game.trump)}</span>
              {isLow(game.trump) && (
                <span className="contract-trump-rule">Doubles {lowDoublesToPrettyString(game.trump)}</span>
              )}
            </span>
          )}
        </div>

        <div className="score score-them">
          <span className="score-label">Them</span>
          <span className="score-value">{scores[opponentTeam] ?? 0}</span>
          <MarkTally marks={scores[opponentTeam] ?? 0} />
        </div>
      </header>

      <div className="game-wrapper">
        {/* One drag context around the table and the hand: a tile is dragged out of the hand and
            played by dropping it on the table. */}
        <PlayDndContext>
          <div className="gameboard">
            <TrickHistory
              tricks={myTricks}
              points={myTrickPoints}
              align="mine"
              label="Us"
              target={bidderTeam === me.team ? target : null}
            />

            <PlayDropZone live={canPlay} className="table" aria-label="Table">
              {seatedOthers.map(({ player, seat }) => {
                const hand = game.hands.find((h) => h.playerId === player.playerId);
                return (
                  <Seat
                    key={player.playerId}
                    seat={seat}
                    dominoCount={hand ? handSize(hand) : 0}
                    {...seatPropsFor(player.playerId)}
                  />
                );
              })}

              {emptySeats.map(({ position, seat }) => (
                <div key={position} className={`seat seat-${seat} seat-open`} data-testid="open-seat">
                  <div className="seat-plate">
                    <span className="seat-name">Open seat</span>
                    {botsEnabled && (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary seat-add-bot"
                        disabled={!connected || addBotsMutation.isPending}
                        onClick={() => addBotsMutation.mutate(position)}
                      >
                        Add bot
                      </button>
                    )}
                  </div>
                </div>
              ))}

              <div className="table-center">
                {!isTableReady ? (
                  <div className="table-waiting">
                    <p>{match.players.length < 4 ? `${match.players.length} of 4 seated` : 'Dealing'}</p>
                    {botsEnabled && emptySeats.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        disabled={!connected || addBotsMutation.isPending}
                        onClick={() => addBotsMutation.mutate(undefined)}
                      >
                        Fill with bots
                      </button>
                    )}
                    {!hasBeenDealt(match) && (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-danger"
                        disabled={leaveMutation.isPending}
                        onClick={() => {
                          if (window.confirm(onlyHumanSeated ? 'Cancel this match? It will be deleted.' : 'Leave this table?')) {
                            leavingRef.current = true;
                            leaveMutation.mutate();
                          }
                        }}
                      >
                        {onlyHumanSeated ? 'Cancel match' : 'Leave table'}
                      </button>
                    )}
                  </div>
                ) : (
                  <TrickDisplay
                    trick={displayedTrick}
                    trump={game.trump}
                    slotSeats={trickSlotSeats}
                    winningSlot={winningSlot}
                    sweepTo={sweepTo}
                    sweepMode={sweepMode}
                    sweepTarget={sweepTarget}
                  />
                )}
              </div>

              <Seat seat="bottom" dominoCount={null} {...seatPropsFor(myPlayerId)} />
            </PlayDropZone>

            <TrickHistory
              tricks={opponentTricks}
              points={opponentTrickPoints}
              align="opponent"
              label="Them"
              target={bidderTeam === opponentTeam ? target : null}
            />
          </div>

          <div className={`player${me.isActive && !isHandPlayedOut && isTableReady ? ' active' : ''}`}>
            {showHandOver && (
              <section className="hand-result" aria-label="Hand over">
                <p className="hand-result-title">
                  {isMatchOver
                    ? match.winningTeam === me.team
                      ? 'You won the match'
                      : 'They won the match'
                    : handWinner === me.team
                      ? 'We took the hand'
                      : 'They took the hand'}
                </p>
                {isMatchOver ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-secondary"
                      onClick={() => setSummaryOpen(true)}
                    >
                      Match summary
                    </button>
                    {match.rematchId ? (
                      <Link to={`/match/${match.rematchId}`} className="action-button">
                        Go to rematch
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className="action-button"
                        disabled={iVotedRematch || !connected || rematchMutation.isPending}
                        onClick={() => rematchMutation.mutate()}
                      >
                        {iVotedRematch ? `Waiting for rematch (${rematchAgreed(match).length} of 4)` : 'Rematch'}
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <p className="hand-result-note">
                      {iAmReady
                        ? `Waiting for everyone to ready up (${readyCount} of 4)`
                        : isHandPlayedOut
                          ? 'Ready up for the next hand'
                          : 'Play it out, or ready up for the next hand'}
                    </p>
                    <button
                      type="button"
                      className="action-button"
                      disabled={iAmReady || !connected || readyUpMutation.isPending}
                      onClick={() => readyUpMutation.mutate()}
                    >
                      {iAmReady ? "You're ready" : 'Ready up'}
                    </button>
                  </>
                )}
              </section>
            )}

            {/* The bid/trump pickers carry their own prompt, so the status line steps aside. */}
            {!canBid && !canSelectTrump && status != null && (
              <p className={`rail-status${isSittingOut ? ' rail-sitting-out' : ''}`} role="status">
                {status}
              </p>
            )}

            {poke.target != null && (
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary rail-poke"
                disabled={poke.pending}
                onClick={poke.poke}
              >
                Poke {nameFor(poke.target)}
              </button>
            )}

            {canBid && (
              <BiddingPanel
                game={game}
                myPlayerId={myPlayerId}
                onBid={(bid) => bidMutation.mutate(bid)}
                disabled={!connected || bidMutation.isPending}
              />
            )}

            {canSelectTrump && (
              <TrumpPicker
                game={game}
                onSelect={(suit) => setTrumpMutation.mutate(suit)}
                disabled={!connected || setTrumpMutation.isPending}
              />
            )}

            <Hand
              // My hand as the server last sent it, with a domino in flight hidden but keeping its
              // place, in case the play is turned away.
              dominoes={myLiveHand}
              playingId={inFlight?.id ?? null}
              selectable={canPlay}
              onPlay={playDomino}
              isValidPlay={isValidPlay}
              highlightPlayable={highlightPlayable}
            />
          </div>
        </PlayDndContext>
      </div>

      {showHandOver && isMatchOver && summaryOpen && (
        <MatchSummary
          match={match}
          myTeam={me.team}
          nameFor={nameFor}
          iVoted={iVotedRematch}
          rematchDisabled={!connected || rematchMutation.isPending}
          onRematch={() => rematchMutation.mutate()}
          onClose={() => setSummaryOpen(false)}
        />
      )}
    </div>
  );
}

// The /match/:matchId route. Keyed by id so following a rematch mounts a fresh page: the trick
// hold, the sweep, and the new-hand tracker all belong to one match and mustn't carry over.
export function MatchRoute(): JSX.Element {
  const { matchId } = useParams<{ matchId: string }>();
  return <Match key={matchId} />;
}
