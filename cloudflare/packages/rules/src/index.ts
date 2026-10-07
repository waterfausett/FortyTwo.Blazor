// Interfaces go out through `export type`: the web app's Vite build compiles each file on its own,
// where an interface has no runtime value, so a plain `export { Domino }` fails to bundle with
// "Domino is not exported".
export type { Domino } from './domino';
export {
  createDomino,
  shuffledDominoOrder,
  dominoValue,
  isDouble,
  getSuit,
  isOfSuit,
  getSuitValue,
  dominoEquals,
} from './domino';
export type { Trick } from './trick';
export { createTrick, trickValue, isTrickFull, isTrickEmpty, addDominoToTrick } from './trick';
export type { Hand } from './hand';
export type { Game } from './game';
export { gameValue, gameWinningTeam } from './game';
export type { MatchPlayerRef } from './match';
export { selectNextPlayer } from './match';
export { Suit, LOW_TRUMPS, isLow, suitToPrettyString, lowDoublesToPrettyString } from './suit';
export { Bid, bidToPrettyString, pointsToMakeBid } from './bid';
export { Teams, teamForPosition } from './teams';
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
  availableBids,
  availableTrumps,
  assertValidTrump,
} from './validation';
export type { MatchPlayerState, MatchState, LoggedInPlayer } from './matchEngine';
export {
  createMatch,
  addPlayer,
  takeSeat,
  patchPlayerReady,
  placeBid,
  setTrump,
  playDomino,
  getPlayerView,
  matchScores,
  voteRematch,
  rematchAgreed,
  createRematch,
  removePlayer,
  hasBeenDealt,
  hasHumanPlayers,
} from './matchEngine';
export { BOT_IDS, botDisplayName, isBot } from './botIds';
export { matchViewFor, handSize } from './view';
