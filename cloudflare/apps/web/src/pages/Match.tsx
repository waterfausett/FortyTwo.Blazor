// The match page: live bidding, trump selection, hand, and trick display. Replaces
// FortyTwo/Client/Pages/Match.razor(.cs) + Components/Domino.razor/RemotePlayer.razor/Chip.razor.
// Live state comes from `useMatchSocket` (Task 19's WebSocket hook, replacing the old app's
// SignalR `HubConnection`); actions (`bid`/`setTrump`/`playDomino`) are `apiClient()` mutations
// via TanStack Query's `useMutation`. Layout is `styles/match.css`, ported from
// `FortyTwo/Client/Pages/Match.razor.css` (a Blazor CSS-isolation scoped stylesheet Task 17's
// CSS port missed entirely, since it only identified/copied the 4 global stylesheets) plus
// Match.razor's own inline `<style>` block - see match.css's header comment for the full mapping.
//
// Scope note: this DOES port a "Ready Up" between-games flow (`readyUp`/`patchPlayerReady`) - it
// was originally left out (Task 20's brief interfaces section only listed `bid`/`setTrump`/
// `playDomino`), but that turned out to be load-bearing: `readyUp` is the ONLY mechanism that ever
// deals a new hand once the current one has a winner (the very first hand deals automatically on
// the 4th join), so without it a match could complete its first hand and then simply never
// continue. See the "Hand over" section below, gated on `gameWinningTeam(currentGame) !== null`.
// A decided hand can still be played out: play stays open until all 7 tricks are down, and the
// next hand deals as soon as all four players ready up, whether or not they finished playing.
// Rejected actions (an illegal play, a stale bid) pop a SweetAlert2 toast (ui/toast.ts), as the
// old app did; its "next game started" / "match over" modals are still not ported.
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useAuth0 } from '@auth0/auth0-react';
import { useParams } from 'react-router-dom';
import type { Domino as DominoType, Game, Trick } from '@fortytwo/rules';
import {
  Bid,
  Suit,
  Teams,
  bidToPrettyString,
  suitToPrettyString,
  getPlayerView,
  matchScores,
  trickValue,
  gameWinningTeam,
  assertValidDomino,
  isLow,
  lowDoublesToPrettyString,
} from '@fortytwo/rules';
import { apiClient } from '../api/client';
import { useGetToken } from '../auth/useGetToken';
import { useMatchSocket } from '../api/useMatchSocket';
import { BiddingPanel } from '../components/BiddingPanel';
import { Hand } from '../components/Hand';
import { PipFace } from '../components/PipFace';
import { TrumpPicker } from '../components/TrumpPicker';
import { Seat } from '../components/Seat';
import { TrickDisplay } from '../components/TrickDisplay';
import { TrickHistory } from '../components/TrickHistory';
import { toastError } from '../ui/toast';
import { dealerId, isTrickStarted, seatFor, trickLeaderId, trickPlayOrder } from '../match/table';
import type { Point } from '../match/sweep';
import { pileLandingPoint, readSweepMode, seatPoint, sweepDurationMs } from '../match/sweep';
import '../styles/match.css';

// How long a just-completed trick stays put in the center of the board (as if still "in
// progress") before it's swept off to its team's side pile - long enough to actually see what
// was played, instead of the trick vanishing the instant the last domino lands.
const TRICK_HOLD_MS = 1500;
// The tail end of that hold is the sweep (match/sweep.ts's `sweepDurationMs`), during which the
// trick leaves for the winning side rather than just blinking out.

// A match is won at 7 marks (matchEngine.ts's WINNING_SCORE) - drawn as a 7-notch tally.
const MARKS_TO_WIN = 7;

// Every hand is always dealt exactly 7 dominoes (matchEngine.ts's dealHands: 28 dominoes / 4
// players) - used to detect whether a player has already played into the current, still-in-
// progress trick (see `haveIPlayedInCurrentTrick` below).
const HAND_SIZE_DEALT = 7;
// Every hand runs exactly 7 tricks, Low included (the bidder's partner just never plays theirs).
const TRICKS_PER_HAND = 7;

function otherTeam(team: Teams): Teams {
  return team === Teams.TeamA ? Teams.TeamB : Teams.TeamA;
}

// A team's cumulative point value across a set of already-COMPLETED tricks (i.e. NOT the trick
// still being played - that's TrickDisplay's job, and is a different, separate metric). Port of
// Match.razor:132/143's `teamTricks.Sum(x => x.Value)` where
// `teamTricks = CurrentGame.Tricks.Where(x => x.Team == team)`. `trickValue()` already includes
// the +1 base point per trick (trick.ts), so it isn't added again here.
//
// Takes the tricks list rather than `Game` directly so callers can pass either the true
// `game.tricks` or the hold-delayed "revealed" subset (see `Match()`'s `revealedTrickCount`) -
// the two diverge for ~`TRICK_HOLD_MS` right after a trick completes, while it's still being
// shown center-board instead of having moved to the side pile.
function teamTrickPoints(tricks: Trick[], team: Teams): number {
  return tricks.filter((t) => t.team === team).reduce((sum, t) => sum + trickValue(t), 0);
}

// Port of Match.razor:114's `shouldStack` - once a hand's bid gets big enough (and isn't Plunge or
// a Low-trump hand, both of which keep every trick meaningful to look back on), each side's trick
// pile is trimmed to just the last 2 so it doesn't grow into an unbounded scroll of tiny dominoes.
function shouldStackTricks(game: Game): boolean {
  return game.bid != null && game.bid > Bid.FortyTwo && game.bid !== Bid.Plunge && !isLow(game.trump);
}

// Port of Match.razor:117-118's `teamTricks.Skip(Math.Max(0, teamTricks.Count() - 2))`.
function teamTricksForDisplay(tricks: Trick[], team: Teams, stack: boolean): Trick[] {
  const teamTricks = tricks.filter((t) => t.team === team);
  return stack ? teamTricks.slice(Math.max(0, teamTricks.length - 2)) : teamTricks;
}

// The points a bidding team has to take to make its bid: the bid itself for 30-42, or all 42 for
// any marks bid (84, 126, ... - gameWinningTeam's `adjustedBid`). Low has no point target at all
// (the bidders simply must not take a trick), and there's no target until bidding closes.
function bidTarget(game: Game): number | null {
  if (game.bid == null || game.trump == null || isLow(game.trump)) return null;
  return game.bid % 42 === 0 ? 42 : game.bid;
}

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

  const { match: socketMatch } = useMatchSocket(matchId ?? '', getToken);
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
  });

  // Prefer the socket's state once it has ANY value (it's the live source of truth once connected);
  // fall back to the REST query's data before that (first paint, or while the socket is still
  // (re)connecting).
  const match = socketMatch ?? matchQuery.data ?? null;

  // Display names for everyone seated. Keyed on the sorted id list so it refetches only when
  // someone joins, not on every broadcast. Until it resolves (or if it fails), and for bots, which
  // have no Auth0 account, `nameFor` below falls back to the raw player id.
  const seatedIds = (match?.players.map((p) => p.playerId) ?? []).sort();
  const namesQuery = useQuery({
    queryKey: ['playerNames', seatedIds],
    queryFn: async () => {
      const users = await client.searchUsers(seatedIds);
      return new Map(users.map((u) => [u.user_id, u.displayName]));
    },
    enabled: seatedIds.length > 0,
    staleTime: Infinity,
  });

  const bidMutation = useMutation({
    mutationFn: (bid: Bid) => client.bid(matchId!, bid),
    onError: toastError,
  });
  const setTrumpMutation = useMutation({
    mutationFn: (suit: Suit) => client.setTrump(matchId!, suit),
    onError: toastError,
  });
  // `client.playDomino` resolves with the fresh MatchState too, but Match.tsx never reads
  // `playMutation.data` - the live `match` below only ever updates from `useMatchSocket`'s
  // broadcast. That leaves a real gap between MY OWN play resolving (isPending flips back to
  // false) and the broadcast confirming the turn actually moved on - during which the still-stale
  // `match` would otherwise let `canPlay` read true again. `awaitingTurnAdvance` (set here, cleared
  // by the effect below once the broadcast shows the played domino actually gone from my hand)
  // closes that gap. `lastPlayedDominoIdRef` records WHICH domino to watch for, since the clearing
  // condition can't key off `currentPlayerId` changing (see that effect's comment for why).
  const [awaitingTurnAdvance, setAwaitingTurnAdvance] = useState(false);
  const lastPlayedDominoIdRef = useRef<string | null>(null);
  const playMutation = useMutation({
    mutationFn: (domino: DominoType) => client.playDomino(matchId!, { top: domino.top, bottom: domino.bottom }),
    onSuccess: (_data, domino) => {
      lastPlayedDominoIdRef.current = domino.id;
      setAwaitingTurnAdvance(true);
    },
    onError: toastError,
  });
  const readyUpMutation = useMutation({
    mutationFn: () => client.readyUp(matchId!, true),
    onError: toastError,
  });

  // Trick-hold state: `revealedTrickCount` is how many of `game.tricks` have finished their hold
  // (see TRICK_HOLD_MS above) and are allowed to appear in the side piles/point totals. Any trick
  // past that count is still being shown center-board - `heldTrick` below. Derived from
  // `match?.currentGame` rather than the `game` constant below since hooks must run
  // unconditionally, ahead of this function's early-return guards.
  const holdGame = match?.currentGame ?? null;
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

  // Closes `awaitingTurnAdvance`'s gap. This does NOT key off `currentPlayerId` changing -
  // whoever wins the trick they just completed leads the NEXT trick too (matchEngine.ts's
  // `playDomino`: `currentPlayerId = currentTrick.playerId` when the trick is full), so a player
  // who plays the trick-winning domino keeps `currentPlayerId === myPlayerId` straight through the
  // broadcast. A "wait for it to change" check would then never clear, permanently disabling
  // `canPlay` until a full page reload reset this component's state (the actual bug reported: a
  // player unable to play - even their last domino - right after winning the trick that emptied
  // their hand). Instead, wait for the concrete, unambiguous fact that MY play landed: the domino
  // I just submitted is no longer in my hand per the latest broadcast.
  useEffect(() => {
    if (!awaitingTurnAdvance || !holdGame) return;
    const myHand = holdGame.hands.find((h) => h.playerId === myPlayerId);
    const playedDominoStillInHand =
      myHand?.dominoes.some((d) => d.id === lastPlayedDominoIdRef.current) ?? false;
    if (!playedDominoStillInHand) {
      setAwaitingTurnAdvance(false);
    }
  }, [awaitingTurnAdvance, holdGame, myPlayerId]);

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

  // The table must actually be full AND dealt before bidding can be considered "in progress" -
  // otherwise the creator's solo 1-hand view (joined, but alone) satisfies `hands.some(bid==null)`
  // trivially, "completing" bidding for a game that never really started; when players 2-4 join
  // later, their fresh (bid: null) hands never re-trigger bidding since currentPlayerId already
  // moved on, permanently deadlocking the match. Requiring all 4 seats AND a real deal closes that
  // gap.
  //
  // "Dealt" must NOT be judged by any single hand (`hands[0].dominoes.length > 0`, a prior bug
  // here): within the final trick, players play one at a time, so whichever player acts first
  // empties their hand while the other 3 still hold one domino each - if that first-to-act player
  // happens to be `hands[0]` (the match creator), a single-hand check flips false mid-trick and
  // deadlocks a match that's still very much in progress. Checking across every hand, plus the
  // trick history/in-progress trick, stays true for as long as ANY play could still legally happen.
  const isTableReady =
    match.players.length === 4 &&
    game.hands.length === 4 &&
    (game.hands.some((h) => h.dominoes.length > 0) ||
      game.tricks.length > 0 ||
      game.currentTrick.dominoes.some((d) => d !== null));
  const isBiddingPhase = isTableReady && game.hands.some((h) => h.bid == null);
  const isTrumpSelectPhase = isTableReady && !isBiddingPhase && game.trump == null;
  const isPlayingPhase = isTableReady && !isBiddingPhase && game.trump != null;

  const canBid = isBiddingPhase && me.isActive;
  const canSelectTrump = isTrumpSelectPhase && me.isActive;
  const canPlay = isPlayingPhase && me.isActive && !playMutation.isPending && !awaitingTurnAdvance;

  // Once the current hand has a winner, the ONLY way to continue is for all 4 players to
  // explicitly ready up again (patchPlayerReady deals the next hand once everyone has) - with no
  // UI for this, a match could play its first hand to completion and then simply never continue.
  // Until then the hand can still be played out, up to its last trick.
  const isHandOver = gameWinningTeam(game) !== null;
  const isHandPlayedOut = game.tricks.length === TRICKS_PER_HAND;
  const myReadyState = match.players.find((p) => p.playerId === myPlayerId);
  const iAmReady = myReadyState?.ready ?? false;
  const readyCount = match.players.filter((p) => p.ready).length;

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

  const dealer = isTableReady ? dealerId(match.players, game) : null;
  const bidderTeam = game.hands.find((h) => h.playerId === game.biddingPlayerId)?.team ?? null;
  const target = bidTarget(game);
  const handWinner = gameWinningTeam(game);
  const isMatchOver = match.winningTeam != null;

  const nameFor = (playerId: string | null): string =>
    playerId === myPlayerId ? 'You' : playerId == null ? '' : (namesQuery.data?.get(playerId) ?? playerId);
  const activeName = nameFor(game.currentPlayerId);

  // The markers every seat plate (mine included) shows, keyed off a player id.
  function seatPropsFor(playerId: string) {
    const player = match!.players.find((p) => p.playerId === playerId);
    const hand = game.hands.find((h) => h.playerId === playerId);
    const isHighBidder = game.biddingPlayerId === playerId && game.bid != null && game.bid !== Bid.Pass;
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

  // On a Low hand the bidder plays alone, so their partner never gets a turn (selectNextPlayer
  // skips them) - tell them why rather than leaving them watching "X to play" all hand.
  const isSittingOut =
    isPlayingPhase &&
    !isHandPlayedOut &&
    isLow(game.trump) &&
    game.biddingPlayerId !== myPlayerId &&
    bidderTeam === me.team;

  // One line on the rail saying what the table is waiting on. Once the last trick of a decided
  // hand is down there's no play left to describe - the hand-over panel says what comes next.
  let status: string | null;
  if (!isTableReady)
    status = match.players.length < 4 ? `Waiting for players: ${match.players.length} of 4 seated` : 'Dealing';
  else if (isHandPlayedOut) status = null;
  else if (isBiddingPhase) status = `${activeName} is bidding`;
  else if (isTrumpSelectPhase) status = `${activeName} is naming trump`;
  else if (isSittingOut)
    status = `${nameFor(game.biddingPlayerId)} went Low and plays alone, so you sit this hand out. They need to lose every trick.`;
  else if (me.isActive) status = isTrickStarted(game.currentTrick) ? 'Your play' : 'Your lead';
  else status = `${activeName} to play`;

  // A player plays exactly once per trick (dealHands deals HAND_SIZE_DEALT each) - so if this
  // hand already holds fewer dominoes than "HAND_SIZE_DEALT minus completed tricks", they've
  // already played into the CURRENT (still in-progress) trick and can't play again until the NEXT
  // one starts. Any preselection made right now is therefore for that next, not-yet-started trick -
  // `game.currentTrick.suit` (the trick they already played into) has no bearing on it.
  const haveIPlayedInCurrentTrick = (me.dominoes?.length ?? 0) < HAND_SIZE_DEALT - game.tricks.length;

  // Gates which dominoes Hand will let a player preselect (double-click before their turn) -
  // reuses the same follow-suit rule the server enforces (`assertValidDomino`), so a preselection
  // can only ever be queued for a move that's actually legal right now. When the trick hasn't
  // started yet (`currentTrick.suit === null`) - or isn't even the trick this preselection is
  // really for, per `haveIPlayedInCurrentTrick` above - anything can be preselected, since there's
  // no known suit yet to violate.
  function isValidPlay(domino: DominoType): boolean {
    if (haveIPlayedInCurrentTrick) return true;
    try {
      assertValidDomino(game, me.playerId, domino);
      return true;
    } catch {
      return false;
    }
  }

  return (
    <div ref={matchRootRef} className="match">
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
                <span className="contract-trump-rule">{lowDoublesToPrettyString(game.trump)}</span>
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
        <div className="gameboard">
          <TrickHistory
            tricks={myTricks}
            points={myTrickPoints}
            align="mine"
            label="Us"
            target={bidderTeam === me.team ? target : null}
          />

          <div className="table" aria-label="Table">
            {seatedOthers.map(({ player, seat }) => {
              const hand = game.hands.find((h) => h.playerId === player.playerId);
              return (
                <Seat
                  key={player.playerId}
                  seat={seat}
                  dominoCount={hand?.dominoes.length ?? 0}
                  {...seatPropsFor(player.playerId)}
                />
              );
            })}

            <div className="table-center">
              {!isTableReady ? (
                <p className="table-waiting">{match.players.length < 4 ? `${match.players.length} of 4 seated` : 'Dealing'}</p>
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
          </div>

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
              {!isMatchOver && (
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
                    disabled={iAmReady || readyUpMutation.isPending}
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

          {canBid && (
            <BiddingPanel
              game={game}
              myPlayerId={myPlayerId}
              onBid={(bid) => bidMutation.mutate(bid)}
              disabled={bidMutation.isPending}
            />
          )}

          {canSelectTrump && (
            <TrumpPicker
              game={game}
              onSelect={(suit) => setTrumpMutation.mutate(suit)}
              disabled={setTrumpMutation.isPending}
            />
          )}

          <Hand
            dominoes={me.dominoes ?? []}
            selectable={canPlay}
            onPlay={(domino) => playMutation.mutate(domino)}
            isValidPlay={isValidPlay}
          />
        </div>
      </div>
    </div>
  );
}
