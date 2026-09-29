// The hands a finished match was played over, for the match-over summary. A hand is filed under
// the team that took it (matchEngine.ts's playDomino) as soon as it's decided, so the filed games
// are exactly the decided hands; the key is the winner.
import { gameValue, Teams, type Game, type MatchState } from '@fortytwo/rules';

export interface PlayedHand {
  game: Game;
  winner: Teams;
  // Whether the bidding team took the hand.
  made: boolean;
  // Marks the hand scored for its winner.
  marks: number;
}

// "Game 10" sorts after "Game 9": by the number in the name, which counts up one per hand.
function gameNumber(game: Game): number {
  return Number(game.name.replace(/\D/g, '')) || 0;
}

export function playedHands(match: MatchState): PlayedHand[] {
  const hands: PlayedHand[] = [];
  for (const [key, games] of Object.entries(match.games) as [string, Game[] | undefined][]) {
    const winner = Number(key) as Teams;
    for (const game of games ?? []) {
      const bidderTeam = game.hands.find((h) => h.playerId === game.biddingPlayerId)?.team ?? null;
      hands.push({ game, winner, made: bidderTeam === winner, marks: gameValue(game) ?? 0 });
    }
  }
  return hands.sort((a, b) => gameNumber(a.game) - gameNumber(b.game));
}
