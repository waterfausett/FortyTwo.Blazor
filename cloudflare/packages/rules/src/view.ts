// What one person may see of a match. The stored MatchState holds every hand; anything sent to a
// client goes through matchViewFor first so nobody can read another player's dominoes.
import { Game } from './game';
import { Hand } from './hand';
import { MatchState } from './matchEngine';
import { Teams } from './teams';

function hideHand(hand: Hand): Hand {
  return { ...hand, dominoes: [], hiddenCount: hand.dominoes.length };
}

function gameViewFor(game: Game, viewerId: string): Game {
  return { ...game, hands: game.hands.map((h) => (h.playerId === viewerId ? h : hideHand(h))) };
}

// The match as `viewerId` may see it: their own hand in full, everyone else's reduced to a count.
// Someone who isn't seated sees every hand hidden. Filed games are covered too - a decided hand is
// filed as soon as it's won but can still be played out, so its copy holds unplayed dominoes.
export function matchViewFor(match: MatchState, viewerId: string): MatchState {
  const games: MatchState['games'] = {};
  for (const [team, filed] of Object.entries(match.games) as [string, Game[] | undefined][]) {
    games[Number(team) as Teams] = filed?.map((g) => gameViewFor(g, viewerId));
  }
  return { ...match, currentGame: gameViewFor(match.currentGame, viewerId), games };
}

// How many dominoes a hand holds, whether or not the viewer can see them.
export function handSize(hand: Hand): number {
  return hand.hiddenCount ?? hand.dominoes.length;
}
