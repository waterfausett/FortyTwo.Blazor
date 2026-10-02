// What a seated player can see and do in a match right now, worked out from MatchState alone: the
// phase of the hand, whose turn it is, which plays are legal, and how the hand and match stand.
// Shared by the web and mobile match screens, so both apply exactly the same reading of the rules.
// Only state belongs here - a screen adds its own UI conditions (socket connected, a request in
// flight) on top.
import {
  Bid,
  Teams,
  assertValidDomino,
  gameWinningTeam,
  getPlayerView,
  handSize,
  isLow,
  trickValue,
  type Domino,
  type Game,
  type LoggedInPlayer,
  type MatchState,
  type Trick,
} from '@fortytwo/rules';
import { dealerId, isTrickStarted } from './table';

// A match is won at 7 marks (matchEngine.ts's WINNING_SCORE).
export const MARKS_TO_WIN = 7;
// Every hand runs exactly 7 tricks, Low included (the bidder's partner just never plays theirs).
export const TRICKS_PER_HAND = 7;
// Every hand is dealt exactly 7 dominoes (matchEngine.ts's dealHands: 28 dominoes / 4 players).
const HAND_SIZE_DEALT = 7;

export function otherTeam(team: Teams): Teams {
  return team === Teams.TeamA ? Teams.TeamB : Teams.TeamA;
}

// A team's points across a set of completed tricks. `trickValue()` already includes the +1 base
// point per trick (trick.ts).
export function teamTrickPoints(tricks: Trick[], team: Teams): number {
  return tricks.filter((t) => t.team === team).reduce((sum, t) => sum + trickValue(t), 0);
}

// Once a hand's bid is past 42 - and isn't Plunge or a Low hand, both of which keep every trick
// worth looking back on - each side's pile of taken tricks shows only its last two, so it doesn't
// grow into a long run of tiny dominoes.
export function shouldStackTricks(game: Game): boolean {
  return game.bid != null && game.bid > Bid.FortyTwo && game.bid !== Bid.Plunge && !isLow(game.trump);
}

// A team's pile of taken tricks, in the order they were won: every one, or the last two when
// stacked.
export function teamTricksForDisplay(tricks: Trick[], team: Teams, stack: boolean): Trick[] {
  const teamTricks = tricks.filter((t) => t.team === team);
  return stack ? teamTricks.slice(Math.max(0, teamTricks.length - 2)) : teamTricks;
}

// The points a bidding team has to take to make its bid: the bid itself for 30-42, or all 42 for
// any marks bid (84, 126, ... - gameWinningTeam's `adjustedBid`). Low has no point target at all
// (the bidders simply must not take a trick), and there's no target until bidding closes.
export function bidTarget(game: Game): number | null {
  if (game.bid == null || game.trump == null || isLow(game.trump)) return null;
  return game.bid % 42 === 0 ? 42 : game.bid;
}

export interface MatchView {
  me: LoggedInPlayer;
  myTeam: Teams;
  opponentTeam: Teams;
  // All four seated and a hand dealt. Until then nobody can bid or play.
  isTableReady: boolean;
  isBiddingPhase: boolean;
  isTrumpSelectPhase: boolean;
  isPlayingPhase: boolean;
  canBid: boolean;
  canSelectTrump: boolean;
  // My turn to play a domino. A screen also needs its socket up and no play in flight.
  isMyTurnToPlay: boolean;
  // A team has won the hand. Play stays open until all 7 tricks are down, and the next hand deals
  // once all four ready up, whether or not they finished playing.
  isHandOver: boolean;
  isHandPlayedOut: boolean;
  handWinner: Teams | null;
  isMatchOver: boolean;
  // On a Low hand the bidder plays alone, so their partner never gets a turn.
  isSittingOut: boolean;
  // Whether I've already played into the trick in progress, so any play I pick now is for the next.
  haveIPlayedInCurrentTrick: boolean;
  iAmReady: boolean;
  readyCount: number;
  iVotedRematch: boolean;
  bidderTeam: Teams | null;
  dealer: string | null;
  // The bidding team's point target, or null (see `bidTarget`).
  target: number | null;
}

// `myPlayerId` must be seated in the match (getPlayerView throws otherwise).
export function describeMatch(match: MatchState, myPlayerId: string): MatchView {
  const game = match.currentGame;
  const me = getPlayerView(match, myPlayerId);

  // The table must be full AND dealt. Otherwise the creator's solo one-hand view (joined, but
  // alone) would satisfy `hands.some(bid == null)` trivially and "complete" bidding for a game
  // that never started. "Dealt" is judged across every hand plus the trick history, never by a
  // single hand: in the last trick, whoever plays first empties their hand while the other three
  // still hold one domino each.
  const isTableReady =
    match.players.length === 4 &&
    game.hands.length === 4 &&
    // handSize, not dominoes.length: other players' hands arrive hidden, as a count.
    (game.hands.some((h) => handSize(h) > 0) ||
      game.tricks.length > 0 ||
      game.currentTrick.dominoes.some((d) => d !== null));
  const isBiddingPhase = isTableReady && game.hands.some((h) => h.bid == null);
  const isTrumpSelectPhase = isTableReady && !isBiddingPhase && game.trump == null;
  const isPlayingPhase = isTableReady && !isBiddingPhase && game.trump != null;

  const handWinner = gameWinningTeam(game);
  const isHandPlayedOut = game.tricks.length === TRICKS_PER_HAND;
  const bidderTeam = game.hands.find((h) => h.playerId === game.biddingPlayerId)?.team ?? null;

  return {
    me,
    myTeam: me.team,
    opponentTeam: otherTeam(me.team),
    isTableReady,
    isBiddingPhase,
    isTrumpSelectPhase,
    isPlayingPhase,
    canBid: isBiddingPhase && me.isActive,
    canSelectTrump: isTrumpSelectPhase && me.isActive,
    isMyTurnToPlay: isPlayingPhase && me.isActive,
    isHandOver: handWinner !== null,
    isHandPlayedOut,
    handWinner,
    isMatchOver: match.winningTeam != null,
    isSittingOut:
      isPlayingPhase &&
      !isHandPlayedOut &&
      isLow(game.trump) &&
      game.biddingPlayerId !== myPlayerId &&
      bidderTeam === me.team,
    // A player plays once per trick, so holding fewer than "dealt minus completed tricks" means
    // they've already played into the current one.
    haveIPlayedInCurrentTrick: (me.dominoes?.length ?? 0) < HAND_SIZE_DEALT - game.tricks.length,
    iAmReady: match.players.find((p) => p.playerId === myPlayerId)?.ready ?? false,
    readyCount: match.players.filter((p) => p.ready).length,
    iVotedRematch: match.rematchVotes?.includes(myPlayerId) ?? false,
    bidderTeam,
    dealer: isTableReady ? dealerId(match.players, game) : null,
    target: bidTarget(game),
  };
}

// Whether `domino` is a legal play for me right now, by the same follow-suit rule the server
// enforces (`assertValidDomino`). Before a trick has a suit - or when I've already played into the
// current trick, so the pick is for the next one - anything goes.
export function isValidPlay(match: MatchState, view: MatchView, domino: Domino): boolean {
  if (view.haveIPlayedInCurrentTrick) return true;
  try {
    assertValidDomino(match.currentGame, view.me.playerId, domino);
    return true;
  } catch {
    return false;
  }
}

// One line saying what the table is waiting on, or null once a decided hand's last trick is down
// (the hand-over prompt says what comes next). `nameFor` should return 'You' for the viewer.
export function matchStatus(
  match: MatchState,
  view: MatchView,
  nameFor: (playerId: string | null) => string
): string | null {
  const game = match.currentGame;
  if (!view.isTableReady) {
    return match.players.length < 4 ? `Waiting for players: ${match.players.length} of 4 seated` : 'Dealing';
  }
  if (view.isHandPlayedOut) return null;
  const active = nameFor(game.currentPlayerId);
  if (view.isBiddingPhase) return `${active} is bidding`;
  if (view.isTrumpSelectPhase) return `${active} is naming trump`;
  if (view.isSittingOut) {
    return `${nameFor(game.biddingPlayerId)} went Low and plays alone, so you sit this hand out. They need to lose every trick.`;
  }
  if (view.me.isActive) return isTrickStarted(game.currentTrick) ? 'Your play' : 'Your lead';
  return `${active} to play`;
}

// Whether `playerId` holds the winning bid (a real bid, not a Pass).
export function isHighBidder(game: Game, playerId: string): boolean {
  return game.biddingPlayerId === playerId && game.bid != null && game.bid !== Bid.Pass;
}
