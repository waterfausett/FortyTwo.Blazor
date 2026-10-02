// What the match will look like once my play lands, worked out ahead of the server so the screen
// can show it at once: the domino leaves my hand for the trick, the trick's winner so far is
// updated, and the turn moves on - the same steps as the rules engine's playDomino.
//
// A trick my play fills stays on the table as the current trick (with its winner leading next),
// rather than being filed: the server's update files it, and the screen then holds it on the
// table the same as any completed trick, so nothing jumps.
//
// The play must already be legal (`assertPlayable`), and only my own hand is touched - the
// others arrive hidden.
import {
  addDominoToTrick,
  assertValidDomino,
  dominoEquals,
  getSuitValue,
  isTrickFull,
  selectNextPlayer,
  teamForPosition,
  type Domino,
  type MatchState,
} from '@fortytwo/rules';

// Throws the rules' ValidationError (the server's own message) if I may not play `domino` now -
// for the follow-suit rule, the one a player can break by picking the wrong domino.
export function assertPlayable(match: MatchState, playerId: string, domino: Domino): void {
  assertValidDomino(match.currentGame, playerId, domino);
}

export function projectPlay(match: MatchState, playerId: string, domino: Domino): MatchState {
  const game = match.currentGame;
  const trump = game.trump!;
  let currentTrick = addDominoToTrick(game.currentTrick, domino, trump);
  const suit = currentTrick.suit!;
  const winning = currentTrick.dominoes
    .filter((d): d is Domino => d !== null)
    .reduce((best, d) => (getSuitValue(d, suit, trump) > getSuitValue(best, suit, trump) ? d : best));
  if (dominoEquals(winning, domino)) {
    const position = match.players.find((p) => p.playerId === playerId)!.position;
    currentTrick = { ...currentTrick, playerId, team: teamForPosition(position) };
  }
  const currentPlayerId = isTrickFull(currentTrick, trump)
    ? currentTrick.playerId
    : selectNextPlayer(playerId, game.biddingPlayerId, trump, match.players);
  const hands = game.hands.map((h) =>
    h.playerId === playerId ? { ...h, dominoes: h.dominoes.filter((d) => !dominoEquals(d, domino)) } : h
  );
  return { ...match, currentGame: { ...game, hands, currentTrick, currentPlayerId } };
}
