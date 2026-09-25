// Type-only exports (interfaces) are re-exported via `export type` rather than mixed in with the
// value exports below. tsc alone tolerates a plain `export { InterfaceName } from './x'`, since it
// has full cross-module type information - but Vite's production build (rolldown, under
// isolatedModules semantics) transpiles each file independently: an `interface` is erased entirely
// from './domino'`'s JS output, so a same-statement `export { Domino, createDomino } from
// './domino'` fails at bundle time with "Domino is not exported" (MISSING_EXPORT) once anything
// reachable from main.tsx actually imports it - exactly what Task 21's routing wire-up newly does
// for Match.tsx (and therefore this package). `export type` tells every tool, tsc included, that
// the binding is compile-time-only and is dropped before bundling, so this is a pure fix with no
// behavior change for existing consumers (tsc, vitest, apps/worker).
export type { Domino } from './domino';
export { createDomino, dominoValue, isDouble, getSuit, isOfSuit, getSuitValue, dominoEquals } from './domino';
export type { Trick } from './trick';
export { createTrick, trickValue, isTrickFull, isTrickEmpty, addDominoToTrick } from './trick';
export type { Hand } from './hand';
export type { Game } from './game';
export { gameValue, gameWinningTeam } from './game';
export type { MatchPlayerRef } from './match';
export { selectNextPlayer } from './match';
export { Suit, suitToPrettyString } from './suit';
export { Bid, bidToPrettyString } from './bid';
export { Teams } from './teams';
export { Positions, nextPosition } from './positions';
export { ValidationError } from './errors';
export type { MatchLike } from './validation';
export {
  assertActive,
  assertNotFull,
  assertActiveTurn,
  assertActiveBidder,
  assertValidBid,
  assertBiddingComplete,
  assertReadyToPlay,
  assertHasDomino,
  assertValidDomino,
  assertIsMatchPlayer,
  assertIsNotMatchPlayer,
} from './validation';
export type { MatchPlayerState, MatchState, LoggedInPlayer } from './matchEngine';
export {
  createMatch,
  addPlayer,
  patchPlayerReady,
  placeBid,
  setTrump,
  playDomino,
  getPlayerView,
  matchScores,
} from './matchEngine';
