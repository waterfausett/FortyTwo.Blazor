// The hands a finished match was played over, for the match-over summary. A hand is filed under
// the team that took it (matchEngine.ts's playDomino) as soon as it's decided, so the filed games
// are exactly the decided hands; the key is the winner.
import {
  gameValue,
  Positions,
  teamForPosition,
  Teams,
  type Domino,
  type Game,
  type MatchPlayerState,
  type MatchState,
} from '@fortytwo/rules';
import { trickLeaderId, trickPlayOrder } from './table';

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

const SEATS = [Positions.First, Positions.Second, Positions.Third, Positions.Fourth];

// Where each player in `game` sat when it was played. Usually today's seat, but a takeover (#126)
// renames a seat's player from the next hand on, so an earlier game can hold ids no longer at the
// table. Those go to the seat that dealt them their hand - hands are dealt in `players` order,
// which a takeover keeps - or, failing that, the free seat on their team. Null if one can't be
// placed at all.
function gamePlayers(match: MatchState, game: Game): MatchPlayerState[] | null {
  const taken = new Set<number>();
  const seated = game.hands.map((hand) => {
    const position = match.players.find((p) => p.playerId === hand.playerId)?.position;
    if (position !== undefined) taken.add(position);
    return { hand, position };
  });
  const players: MatchPlayerState[] = [];
  for (const [index, { hand, position }] of seated.entries()) {
    let at: Positions | undefined = position;
    if (at === undefined) {
      const free = (p: Positions) => !taken.has(p) && teamForPosition(p) === hand.team;
      const dealtAt = match.players[index]?.position;
      at = dealtAt !== undefined && free(dealtAt) ? dealtAt : SEATS.find(free);
      if (at === undefined) return null;
      taken.add(at);
    }
    players.push({ playerId: hand.playerId, position: at, ready: false });
  }
  return players;
}

// The 7 dominoes `playerId` was dealt for a played hand, highest first; null when they held no
// hand in it (they sat down later) or it's hidden from this view. A game is filed the moment it's
// decided, after its last trick, with each domino already played gone from its hand - so the
// starting hand is what's left plus the player's domino from each trick.
export function startingHand(match: MatchState, game: Game, playerId: string): Domino[] | null {
  const hand = game.hands.find((h) => h.playerId === playerId);
  if (!hand || hand.hiddenCount !== undefined) return null;
  const players = gamePlayers(match, game);
  if (!players) return null;
  const played = game.tricks.flatMap((trick, index) => {
    const slot = trickPlayOrder(players, game, trickLeaderId(players, game, index)).indexOf(playerId);
    const domino = slot === -1 ? null : trick.dominoes[slot];
    return domino ? [domino] : [];
  });
  return [...hand.dominoes, ...played].sort((a, b) => b.bottom - a.bottom || b.top - a.top);
}
