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
// for anyone who wants it; a toast marks each new hand. When the table starts waiting on the player
// - their turn, or a hand over and them not yet ready - TurnAlerts (match/TurnAlerts.tsx) chimes,
// flashes the tab and notifies, per their Profile settings.
//
// Once the player whose turn it is has sat on it for 30 minutes, anyone else at the table gets a
// Poke button (match/usePoke.ts); a player poked while they have this page open gets a toast, and
// TurnAlerts calls them back as for a new turn.
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth0 } from '@auth0/auth0-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { Domino as DominoType, MatchState, Trick } from '@fortytwo/rules';
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
  seatedPlayers,
  isOnAutopilot,
  isPresent,
  matchMode,
  LIVE_FILL_MS,
} from '@fortytwo/rules';
import { formatClock, lobbyCards, suggestedBid, suggestedDominoIds, suggestedTrump, lobbyRoster, nextHandClock, searchState, shuffledTips, seatChanges, serverNow, turnClock, viewerRole, watchAnchor } from '@fortytwo/client';
import { useOnline } from '../api/presence';
import { useStats } from '../api/useStats';
import { SearchLobby } from '../components/SearchLobby';
import { useLobbyHold } from '../match/useLobbyHold';
import { useNow } from '../match/useNow';
import { apiClient } from '../api/client';
import { useGetToken } from '../auth/useGetToken';
import { useMatchSocket } from '../api/useMatchSocket';
import { BiddingPanel } from '../components/BiddingPanel';
import { HintButton, HintDetails } from '../components/HintPanel';
import { useHint } from '../match/useHint';
import { HouseRulesDialog } from '../components/HouseRulesDialog';
import { HowToPlayDialog } from '../components/HowToPlayDialog';
import { InviteDialog } from '../people/InviteDialog';
import { MatchSummary } from '../components/MatchSummary';
import { NameSkeleton } from '../components/NameSkeleton';
import { Hand } from '../components/Hand';
import { PipFace } from '../components/PipFace';
import { PlayDndContext, PlayDropZone } from '../components/PlayDnd';
import { TrumpPicker } from '../components/TrumpPicker';
import { Seat } from '../components/Seat';
import { SeatPicker } from '../components/SeatPicker';
import { TrickDisplay } from '../components/TrickDisplay';
import { TrickHistory } from '../components/TrickHistory';
import { toastError, toastInfo } from '../ui/toast';
import type { TableCall } from '../match/TurnAlerts';
import { TurnAlerts } from '../match/TurnAlerts';
import {
  assertPlayable,
  describeMatch,
  houseRuleLabels,
  marksToWin,
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
  pokeTurnKey,
  nameText,
} from '@fortytwo/client';
import type { Point } from '../match/sweep';
import { pileLandingPoint, readSweepMode, seatPoint, sweepDurationMs } from '../match/sweep';
import { shareInvite } from '../match/invite';
import { usePoke } from '../match/usePoke';
import { usePlayerNames } from '../match/usePlayerNames';
import { useHowToPlay } from '../match/useHowToPlay';
import '../styles/match.css';

// How long a just-completed trick stays put in the center of the board (as if still "in
// progress") before it's swept off to its team's side pile - long enough to actually see what
// was played, instead of the trick vanishing the instant the last domino lands.
const TRICK_HOLD_MS = 1500;
// The tail end of that hold is the sweep (match/sweep.ts's `sweepDurationMs`), during which the
// trick leaves for the winning side rather than just blinking out.

// `total` marks win the match (marksToWin: 7 unless the house rules say otherwise) - drawn as a tally.
function MarkTally({ marks, total }: { marks: number; total: number }): JSX.Element {
  return (
    <span className="mark-tally" aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
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
  // What a poke needs when it lands, from state further down: the sender's display name, once
  // loaded, the turn it's for, and whether a move of mine is already in flight - then the poke is
  // moot. (The Worker only sends a poke while it's still my turn, and the socket keeps its messages
  // in order, so that's the one way one can land late.)
  const pokedRef = useRef<{ nameOf?: (playerId: string) => string | null; turn: string | null; moving: boolean }>({
    turn: null,
    moving: false,
  });
  // The turn I was last poked on (@fortytwo/client's pokeTurnKey), so TurnAlerts can call me back
  // for it - the toast alone goes unseen in a background tab. Stale once that turn has passed.
  const [pokedTurn, setPokedTurn] = useState<string | null>(null);
  const { match: socketMatch, connected, reconnecting, deleted } = useMatchSocket(matchId ?? '', getToken, (from) => {
    if (pokedRef.current.moving) return;
    const poker = pokedRef.current.nameOf?.(from) ?? null;
    toastInfo(poker ? `${poker} poked you` : 'You were poked', "It's your turn", 'center');
    setPokedTurn(pokedRef.current.turn);
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

  // How this player stands at the table. In a Live Play game under way, a newcomer waits
  // for a bot's seat (claiming) and watches meanwhile; one whose wait came to nothing is bumped
  // and looks again; one away a whole hand was replaced by a bot.
  const role = liveMatch && myPlayerId ? viewerRole(liveMatch, myPlayerId) : null;
  // A claimant watches from the first seat's side; everything that acts is switched off for them.
  const watching = role === 'claiming';
  const watchFrom = watching ? watchAnchor(liveMatch!) : null;

  // Display names for everyone seated (match/usePlayerNames.ts). Until a name loads it reads null
  // here and the page shows a placeholder; one that can't be found reads "Player N". Never the id.
  const names = usePlayerNames(liveMatch?.players ?? [], myPlayerId, (ids) => client.searchUsers(ids));
  const nameOf = (playerId: string): string | null => nameText(names.nameFor(playerId));

  const poke = usePoke(liveMatch, myPlayerId, () => client.poke(matchId!), nameOf);

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
  // The rules, over the table, from the scoreboard's "?". Opening them counts as having seen them.
  const [rulesOpen, setRulesOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [houseRulesOpen, setHouseRulesOpen] = useState(false);
  const howToPlay = useHowToPlay(client);
  const navigate = useNavigate();
  // The player's own settings - here, whether to outline their playable dominoes. Shared with the
  // profile page's query, so a change saved there shows up here.
  const profileQuery = useQuery({ queryKey: ['profile'], queryFn: () => client.getProfile(), staleTime: Infinity });
  const highlightPlayable = profileQuery.data?.highlightPlayable ?? false;
  // Bots can be switched off server-side (the Worker's BOTS_ENABLED), so the controls for them only
  // show when the Worker says they're available.
  const configQuery = useQuery({ queryKey: ['config'], queryFn: () => client.getConfig(), staleTime: Infinity });
  const botsEnabled = configQuery.data?.bots ?? false;
  const hintDetails = configQuery.data?.hintDetails ?? false;
  // No hint while a move of mine is already on its way (until the broadcast moves the turn on), nor
  // while a pre-play is queued (Hand's double-click), since that domino plays itself.
  const [preselecting, setPreselecting] = useState(false);
  const moving = preselecting || playing != null || bidMutation.isPending || setTrumpMutation.isPending;
  const hint = useHint(liveMatch ?? null, myPlayerId, botsEnabled, () => client.getHint(matchId!), moving);
  // No position fills every open seat.
  const addBotsMutation = useMutation({
    mutationFn: (position?: number) => client.addBots(matchId!, position),
    onError: toastError,
  });

  // Live search count-up, turn clocks and the next hand countdown: derived from the match, ticking
  // only while one is shown. A paused clock sits at 0:00 until the table moves on, so it doesn't tick.
  const search = liveMatch ? searchState(liveMatch, serverNow()) : null;
  const clockNow = liveMatch ? turnClock(liveMatch, serverNow()) : null;
  const nextHandNow = liveMatch ? nextHandClock(liveMatch, serverNow()) : null;
  const clockRunning =
    liveMatch != null && (search?.mode === 'live' || (clockNow !== null && !clockNow.paused) || nextHandNow !== null);
  const now = useNow(clockRunning);
  const liveSearch = liveMatch ? searchState(liveMatch, now) : null;
  // Stopped, `now` is as old as the last tick, so a stopped clock reads the time afresh.
  const clock = liveMatch ? (clockRunning ? turnClock(liveMatch, now) : clockNow) : null;
  const nextHand = liveMatch ? (clockRunning ? nextHandClock(liveMatch, now) : nextHandNow) : null;
  const mode = liveMatch ? matchMode(liveMatch) : 'custom';
  // A Live search shows the lobby in place of the table, held up a moment once the table fills.
  const lobby = useLobbyHold(liveSearch?.mode === 'live', (liveMatch?.players.length ?? 0) >= 4);
  const stats = useStats({ enabled: lobby });
  // Shuffled once per visit, so the card's order holds steady through the search.
  const [tips] = useState(() => shuffledTips());
  const meOnAutopilot = liveMatch != null && myPlayerId != null && isOnAutopilot(liveMatch, myPlayerId);
  const resumeMutation = useMutation({
    mutationFn: () => client.resume(matchId!),
    onError: toastError,
  });
  const online = useOnline();

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
  // A bumped player is already on their way to another table (below), so isn't told either: a
  // dropped match's last broadcast, which bumps them, arrives before the socket closes.
  const leaveFailed = leaveMutation.isError;
  const bumped = role === 'bumped';
  useEffect(() => {
    if (!deleted || leavingRef.current || bumped) return;
    toastInfo('This match was deleted');
    void queryClient.invalidateQueries({ queryKey: ['matches'] });
    navigate('/', { replace: true });
  }, [deleted, leaveFailed, bumped, navigate, queryClient]);

  // Bumped - the game they were waiting on ended first - this player looks for another Over the
  // table game straight away, once, and goes to it. If that fails they can try again.
  const findAnotherMutation = useMutation({
    mutationFn: () => client.play('live'),
    onSuccess: (found) => navigate(`/match/${found.id}`, { replace: true }),
  });
  const { mutate: findAnother } = findAnotherMutation;
  const searchedAgainRef = useRef(false);
  useEffect(() => {
    if (!bumped || searchedAgainRef.current) return;
    searchedAgainRef.current = true;
    findAnother();
  }, [bumped, findAnother]);

  // "Sam took Bot 2's seat", for each seat that changes hands, once the newcomer's name is in;
  // a player who has just been seated is told they're in instead.
  const previousMatchRef = useRef<MatchState | null>(null);
  const pendingSeatChangesRef = useRef<{ from: string; to: string }[]>([]);
  useEffect(() => {
    if (!liveMatch) return;
    const previous = previousMatchRef.current;
    previousMatchRef.current = liveMatch;
    if (previous && previous.id === liveMatch.id) {
      for (const change of seatChanges(previous, liveMatch)) {
        if (change.to === myPlayerId) toastInfo("You're in", 'You took a seat - your first hand is dealt.');
        // The one leaving has a page of their own to see.
        else if (change.from !== myPlayerId) pendingSeatChangesRef.current.push(change);
      }
    }
    if (!names.ready) return;
    for (const change of pendingSeatChangesRef.current.splice(0)) {
      const to = nameText(names.nameFor(change.to)) ?? 'A player';
      const from = nameText(names.nameFor(change.from)) ?? 'a player';
      toastInfo(`${to} took ${from}'s seat`);
    }
  }, [liveMatch, myPlayerId, names]);

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
      nameOf: (playerId) => nameText(names.nameFor(playerId)),
      turn: liveMatch ? pokeTurnKey(liveMatch) : null,
      moving: playing != null || bidMutation.isPending || setTrumpMutation.isPending,
    };
  }, [names, liveMatch, playing, bidMutation.isPending, setTrumpMutation.isPending]);

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
    const openerName = opener && opener !== myPlayerId ? nameText(names.nameFor(opener)) : null;
    // Before names load there's no one to credit; the title alone says the hand is out.
    const who = opener === myPlayerId ? 'You bid first' : openerName ? `${openerName} bids first` : undefined;
    toastInfo(`${dealtGame.name} dealt`, who, 'center', 1800);
  }, [dealtGame, myPlayerId, names]);

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

  // Having just left, the table's broadcast without this player usually arrives before the
  // leave's own reply navigates away - that's not a seat picker (or a "replaced" note) to show them.
  if (role !== 'seated' && (leaveMutation.isPending || leaveMutation.isSuccess)) {
    return <div className="spinner" role="status" aria-label="Leaving match" />;
  }

  if (role === 'bumped') {
    return (
      <section className="match-join mat-panel" aria-label="Finding another table">
        {findAnotherMutation.isError ? (
          <>
            <p className="match-join-note">That game ended, and no other table could be found just now.</p>
            <button type="button" className="action-button" onClick={() => findAnother()}>
              Find another
            </button>
          </>
        ) : (
          <p className="match-join-note" role="status">
            That game ended - finding you another table…
          </p>
        )}
        <Link to="/" className="match-join-back">
          Back to lobby
        </Link>
      </section>
    );
  }

  if (role === 'replaced') {
    return (
      <section className="match-join mat-panel" aria-label="Your seat was taken">
        <p className="match-join-note">A bot took your seat after you were away for a hand.</p>
        <Link to="/" className="match-join-back">
          Back to lobby
        </Link>
      </section>
    );
  }

  // Someone who isn't seated - typically arriving from an invite link - picks a seat, or learns
  // the match is full.
  if (role === 'stranger') {
    const seats = [0, 1, 2, 3].map((position) => {
      const player = seatedPlayers(liveMatch).find((p) => p.position === position);
      return player ? (nameOf(player.playerId) ?? '') : null;
    });
    // Per seat, so a name that has loaded shows while another is still on its way.
    const loading = [0, 1, 2, 3].map((position) => {
      const player = seatedPlayers(liveMatch).find((p) => p.position === position);
      return player != null && names.nameFor(player.playerId).status === 'loading';
    });
    const open = seats.some((name) => name == null);
    return (
      <section className="match-join mat-panel" aria-label="Join this match">
        <h1 className="match-join-title">{open ? 'Pick a seat to join' : 'This match is full'}</h1>
        {open ? (
          <SeatPicker
            seats={seats}
            loading={loading}
            disabled={joinMutation.isPending}
            onPick={(position) => joinMutation.mutate(position)}
          />
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
  // The table is laid out around whoever it's seen from: this player, or for a claimant watching,
  // the first seat.
  const viewerId = watchFrom ?? myPlayerId;
  const view = describeMatch(match, viewerId);
  const ruleLabels = houseRuleLabels(match.rules);
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
  const canPlay = !watching && view.isMyTurnToPlay && connected && playing == null;
  // Leaving deletes the match when nobody else human is seated, so the button says so.
  const onlyHumanSeated = match.players.every((p) => p.playerId === myPlayerId || isBot(p.playerId));
  // In Live Play, a game with nobody else present is dropped when I leave it.
  const lastPresent = match.players.every((p) => p.playerId === myPlayerId || !isPresent(match, p.playerId));

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
  const trickSlotSeats = trickOrder.map((id) => (id == null ? null : seatFor(match.players, viewerId, id)));
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

  // For sentences: only rendered once names are ready (see the status line), so '' never shows.
  const nameFor = (playerId: string | null): string => (playerId == null ? '' : (nameOf(playerId) ?? ''));

  // The markers every seat plate (mine included) shows, keyed off a player id.
  function seatPropsFor(playerId: string) {
    const player = match!.players.find((p) => p.playerId === playerId);
    const hand = game.hands.find((h) => h.playerId === playerId);
    const isHighBidder = holdsHighBid(game, playerId);
    // While bidding is open everyone's bid (Pass included) shows; once trump is named only the
    // winning bidder's does, alongside the trump they named.
    const bid = game.trump == null ? (hand?.bid ?? null) : isHighBidder ? game.bid : null;
    return {
      name: nameOf(playerId),
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
      away: isOnAutopilot(match!, playerId),
      clock: clock?.playerIds.includes(playerId) ? formatClock(clock.remainingMs) : null,
      paused: clock?.paused === true && clock.playerIds.includes(playerId),
    };
  }

  // How many dominoes a player at the table still holds, face down.
  function dominoCountOf(playerId: string): number {
    const hand = game.hands.find((h) => h.playerId === playerId);
    return hand ? handSize(hand) : 0;
  }

  const myPosition = match.players.find((p) => p.playerId === viewerId)!.position;
  // A parked bot whose seat has opened is drawn as an open seat, not a player.
  const seatedOthers = seatedPlayers(match)
    .filter((p) => p.playerId !== viewerId)
    .map((p) => ({ player: p, seat: seatFor(match.players, viewerId, p.playerId)! }));
  const emptySeats = openSeats(match, viewerId);

  // One line on the rail saying what the table is waiting on - for a watcher, never "Your play".
  const status = matchStatus(
    match,
    watching ? { ...view, isSittingOut: false, me: { ...view.me, isActive: false } } : view,
    nameFor
  );

  // What the table is waiting on me for, for TurnAlerts (match/TurnAlerts.tsx) to pass on when I've
  // looked away - in the push notices' words (apps/worker/src/push/notices.ts). Once the hand is
  // decided, playing it out is optional, so like the push notices it calls me to ready up rather
  // than to play: the next hand deals once all four have, played out or not. Hand and match over
  // wait, like the rail's panel, for the deciding trick to finish its hold.
  function tableCall(): TableCall | null {
    if (showHandOver) {
      if (isMatchOver) {
        return iVotedRematch || match.rematchId
          ? null
          : { kind: 'matchOver', title: 'Match over', body: 'See how it ended, or ask for a rematch.' };
      }
      return iAmReady ? null : { kind: 'handOver', title: 'Hand over', body: 'Ready up for the next hand.' };
    }
    if (isHandOver) return null;
    const title = canBid
      ? 'Your bid'
      : canSelectTrump
        ? 'Name trump'
        : view.isMyTurnToPlay && !isHandPlayedOut
          ? isTrickStarted(game.currentTrick)
            ? 'Your play'
            : 'Your lead'
          : null;
    if (!title) return null;
    const body = `${game.name} is waiting on you.`;
    // Poked on this turn: a call of its own, so it alerts again - in the poke push's words.
    if (pokedTurn === pokeTurnKey(match)) return { kind: 'poke', title: "You've been poked", body };
    return { kind: 'turn', title, body };
  }

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

  // The lobby keeps the page's first children - the turn alerts above all - where the table's
  // page has them, so they stay mounted when the table replaces it: the first turn, which can
  // come as the table fills, alerts like any other.
  if (lobby) {
    const searchingNow = liveSearch?.mode === 'live';
    return (
      <div ref={matchRootRef} className="match">
        {!watching && <TurnAlerts call={tableCall()} tag={match.id} />}
        {reconnecting && (
          <p className="match-reconnecting" role="status" aria-label="Reconnecting">
            Reconnecting…
          </p>
        )}
        <SearchLobby
          roster={lobbyRoster(liveMatch.players, myPlayerId)}
          viewerId={myPlayerId}
          nameOf={nameOf}
          online={online}
          elapsedMs={botsEnabled ? (searchingNow ? liveSearch.elapsedMs : LIVE_FILL_MS) : null}
          full={!searchingNow}
          cards={lobbyCards(stats.data?.all, tips)}
          onStartWithBots={botsEnabled ? () => addBotsMutation.mutate(undefined) : null}
          startDisabled={!searchingNow || !connected || addBotsMutation.isPending}
          onCancel={() => {
            leavingRef.current = true;
            leaveMutation.mutate();
          }}
          cancelDisabled={!searchingNow || leaveMutation.isPending}
          onHowToPlay={() => {
            setRulesOpen(true);
            howToPlay.markSeen();
          }}
        />
        <HowToPlayDialog open={rulesOpen} onClose={() => setRulesOpen(false)} />
      </div>
    );
  }

  return (
    <div ref={matchRootRef} className="match">
      {!watching && <TurnAlerts call={tableCall()} tag={match.id} />}
      {reconnecting && (
        <p className="match-reconnecting" role="status" aria-label="Reconnecting">
          Reconnecting…
        </p>
      )}
      <header className="scoreboard" aria-label="Scores">
        <div className="score score-us">
          <span className="score-label">Us</span>
          <span className="score-value">{scores[me.team] ?? 0}</span>
          <MarkTally marks={scores[me.team] ?? 0} total={marksToWin(match)} />
        </div>

        <div className="contract">
          <span className="contract-game">{game.name}</span>
          {game.bid != null && game.bid !== Bid.Pass && game.biddingPlayerId != null ? (
            <span className={`contract-bid contract-${bidderTeam === me.team ? 'us' : 'them'}`}>
              <span className="contract-label">{game.trump == null ? 'High bid' : 'Bid'}</span>
              <span className="contract-value">{bidToPrettyString(game.bid)}</span>
              <span className="contract-by">{nameOf(game.biddingPlayerId) ?? <NameSkeleton />}</span>
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
          {/* A Custom Match's house rules get a button beside the "?". */}
          {ruleLabels.length > 0 && (
            <button
              type="button"
              className="contract-rules"
              aria-label="House rules"
              onClick={() => setHouseRulesOpen(true)}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor">
                <path d="M3 5h8v2H3zm0 6h8v2H3zm0 6h8v2H3zm10-1.4 1.4-1.4 1.6 1.6 3.6-3.6 1.4 1.4-5 5zM13.4 5.4 15 7l1.6-1.6L18 6.8 16.4 8.4 18 10l-1.4 1.4L15 9.8l-1.6 1.6L12 10l1.6-1.6L12 6.8z" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="contract-rules"
            aria-label="How to play"
            onClick={() => {
              setRulesOpen(true);
              howToPlay.markSeen();
            }}
          >
            ?
          </button>
          {/* A player can leave a game under way: in Live Play a bot takes their seat; a bots match
              ends; in a Custom game a bot finishes the hand and then the seat opens. Up here by the
              rules, well away from the hand. */}
          {(mode === 'live' || mode === 'bots' || mode === 'custom') && hasBeenDealt(match) && !isMatchOver && !watching && (
            <button
              type="button"
              className="contract-leave"
              aria-label="Leave game"
              disabled={leaveMutation.isPending}
              onClick={() => {
                const outcome =
                  mode === 'custom'
                    ? onlyHumanSeated
                      ? 'Nobody else is at the table, so it ends.'
                      : 'A bot finishes this hand for you, then your seat opens for someone new.'
                    : lastPresent
                      ? 'Nobody else is playing, so it ends.'
                      : 'A bot takes your seat.';
                if (window.confirm(`Leave this game? ${outcome}`)) {
                  leavingRef.current = true;
                  leaveMutation.mutate();
                }
              }}
            >
              Leave
            </button>
          )}
        </div>

        <div className="score score-them">
          <span className="score-label">Them</span>
          <span className="score-value">{scores[opponentTeam] ?? 0}</span>
          <MarkTally marks={scores[opponentTeam] ?? 0} total={marksToWin(match)} />
        </div>
      </header>
      {match.currentGame.redealt && isBiddingPhase && (
        <p className="redeal-line" role="status">Everyone passed, so the hands were dealt again.</p>
      )}

      <div className="game-wrapper">
        {meOnAutopilot && !watching && (
          <div className="autopilot-bar" role="status">
            <span>Your turn ran out, so a bot is playing for you.</span>
            <button
              type="button"
              className="btn btn-sm btn-warning"
              disabled={resumeMutation.isPending}
              onClick={() => resumeMutation.mutate()}
            >
              Resume
            </button>
          </div>
        )}
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
              {seatedOthers.map(({ player, seat }) => (
                <Seat
                  key={player.playerId}
                  seat={seat}
                  dominoCount={dominoCountOf(player.playerId)}
                  {...seatPropsFor(player.playerId)}
                />
              ))}

              {emptySeats.map(({ position, seat }) => (
                <div key={position} className={`seat seat-${seat} seat-open`} data-testid="open-seat">
                  <div className="seat-plate">
                    <span className="seat-name">Open seat</span>
                    {mode === 'custom' && botsEnabled && (
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
                {/* At an open-seat break the waiting panel gives way to a trick still on the table - being
                    played out, or just completed and held before its sweep. */}
                {!isTableReady || (view.openSeatCount > 0 && showHandOver && !isTrickStarted(displayedTrick)) ? (
                  <div className="table-waiting">
                    {/* A Live search shows the lobby instead of the table. */}
                    {liveSearch?.mode === 'daily' && (
                      <p className="table-search" role="status">
                        Looking for players - we'll notify you when the table fills.
                      </p>
                    )}
                    <p>{view.openSeatCount > 0 ? `${4 - view.openSeatCount} of 4 seated` : 'Dealing'}</p>
                    {mode === 'custom' && emptySeats.length > 0 && (
                      <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => void shareInvite(match.id)}>
                        Share link
                      </button>
                    )}
                    {mode === 'custom' && emptySeats.length > 0 && (
                      <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setInviting(true)}>
                        Invite players
                      </button>
                    )}
                    {mode === 'custom' && botsEnabled && emptySeats.length > 0 && (
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
                          if (mode === 'live' || window.confirm(onlyHumanSeated ? 'Cancel this match? It will be deleted.' : 'Leave this table?')) {
                            leavingRef.current = true;
                            leaveMutation.mutate();
                          }
                        }}
                      >
                        {mode === 'live' ? 'Cancel search' : onlyHumanSeated ? 'Cancel match' : 'Leave table'}
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
                    pendingId={inFlight?.id ?? null}
                  />
                )}
              </div>

              <Seat
                seat="bottom"
                // A watcher sees the first seat's hand face down, like the others'.
                dominoCount={watching ? dominoCountOf(viewerId) : null}
                {...seatPropsFor(viewerId)}
              />
            </PlayDropZone>

            <TrickHistory
              tricks={opponentTricks}
              points={opponentTrickPoints}
              align="opponent"
              label="Them"
              target={bidderTeam === opponentTeam ? target : null}
            />
          </div>

          <div className={`player${!watching && me.isActive && !isHandPlayedOut && isTableReady ? ' active' : ''}`}>
            {showHandOver && !watching && (
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
                    {view.openSeatCount > 0 && (
                      <p className="hand-result-note">Waiting for a player to take the open seat</p>
                    )}
                    <p className="hand-result-note">
                      {iAmReady
                        ? `Waiting for everyone to ready up (${readyCount} of 4)`
                        : isHandPlayedOut
                          ? 'Ready up for the next hand'
                          : 'Play it out, or ready up for the next hand'}
                    </p>
                    {nextHand !== null && <p className="hand-result-note">Next hand in {formatClock(nextHand)}</p>}
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
            {(watching || (!canBid && !canSelectTrump)) && status != null && (
              <div className="action-prompt-row">
                <p className={`rail-status${isSittingOut ? ' rail-sitting-out' : ''}`} role="status">
                  {names.ready ? status : <NameSkeleton width="12em" />}
                </p>
                {/* My turn to play: the Hint button rides along with "Your turn". */}
                {!watching && <HintButton hint={hint} />}
              </div>
            )}

            {poke.target != null && !watching && (
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary rail-poke"
                disabled={poke.pending}
                onClick={poke.poke}
              >
                Poke {nameOf(poke.target)}
              </button>
            )}

            {canBid && !watching && (
              <BiddingPanel
                game={game}
                myPlayerId={myPlayerId}
                onBid={(bid) => bidMutation.mutate(bid)}
                suggested={suggestedBid(hint.hint)}
                hint={<HintButton hint={hint} />}
                disabled={!connected || bidMutation.isPending}
              />
            )}

            {canSelectTrump && !watching && (
              <TrumpPicker
                game={game}
                onSelect={(suit) => setTrumpMutation.mutate(suit)}
                suggested={suggestedTrump(hint.hint)}
                hint={<HintButton hint={hint} />}
                disabled={!connected || setTrumpMutation.isPending}
              />
            )}

            {!watching && <HintDetails hint={hint} show={hintDetails} />}

            {watching ? (
              <div className="claim-bar" role="status">
                <span>Joining a game in progress. You'll take a seat when this hand ends.</span>
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary"
                  disabled={leaveMutation.isPending}
                  onClick={() => {
                    leavingRef.current = true;
                    leaveMutation.mutate();
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <Hand
                // My hand as the server last sent it, with a domino in flight hidden but keeping its
                // place, in case the play is turned away.
                dominoes={myLiveHand}
                playingId={inFlight?.id ?? null}
                selectable={canPlay}
                onPlay={playDomino}
                isValidPlay={isValidPlay}
                highlightPlayable={highlightPlayable}
                suggestedIds={suggestedDominoIds(hint.hint)}
                onPreselectChange={(id) => setPreselecting(id !== null)}
              />
            )}

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
      <HouseRulesDialog rules={match.rules} open={houseRulesOpen} onClose={() => setHouseRulesOpen(false)} />
      <HowToPlayDialog open={rulesOpen} onClose={() => setRulesOpen(false)} />
      <InviteDialog
        open={inviting}
        matchId={match.id}
        seatedIds={match.players.map((p) => p.playerId)}
        client={client}
        onClose={() => setInviting(false)}
      />
    </div>
  );
}

// The /match/:matchId route. Keyed by id so following a rematch mounts a fresh page: the trick
// hold, the sweep, and the new-hand tracker all belong to one match and mustn't carry over.
export function MatchRoute(): JSX.Element {
  const { matchId } = useParams<{ matchId: string }>();
  return <Match key={matchId} />;
}
