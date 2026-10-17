// Follow suit: holding the led suit, you must play it (validation.assertValidDomino).
import { isOfSuit, type Domino, type Game } from '@fortytwo/rules';

export function legalPlays(game: Game, playerId: string): Domino[] {
  const hand = game.hands.find((h) => h.playerId === playerId)!.dominoes;
  const suit = game.currentTrick.suit;
  if (suit === null) return hand;
  const following = hand.filter((d) => isOfSuit(d, suit, game.trump));
  return following.length ? following : hand;
}
