// What players should hear about after a change to their match, worked out from the match before
// and after it. Pure, so it's tested directly; MatchDO decides who's watching (they have the match
// open, so don't need a push) and push/send.ts delivers the rest.
//
// At most one notice per player for a change, the most pressing:
//   - it's their turn: to bid, to name trump, or to play;
//   - the hand they're in has been decided: ready up for the next one, or the match is over;
//   - the game has started: the last seat was taken and the first hand dealt. Not for a rematch:
//     anyone with the finished match open is taken to it, and everyone else hears when it's their
//     turn, which comes round to every player in the first round of bidding.
// Bots never get one. A poke (poke.ts) is the one notice not worked out here: a player sends it.
import { gameWinningTeam, handSize, isBot, type Game, type MatchState } from '@fortytwo/rules';

export type NoticeKind = 'turn' | 'handOver' | 'matchOver' | 'started' | 'poke';

export interface Notice {
  playerId: string;
  kind: NoticeKind;
  title: string;
  body: string;
  matchId: string;
}

// All four seated and a hand dealt (describeMatch's isTableReady, in @fortytwo/client).
export function isDealt(match: MatchState): boolean {
  const game = match.currentGame;
  return (
    match.players.length === 4 &&
    game.hands.length === 4 &&
    (game.hands.some((h) => handSize(h) > 0) || game.tricks.length > 0 || game.currentTrick.dominoes.some((d) => d !== null))
  );
}

function turnTitle(game: Game): string {
  if (game.hands.some((h) => h.bid == null)) return 'Your bid';
  if (game.trump == null) return 'Name trump';
  return game.currentTrick.dominoes.some((d) => d !== null) ? 'Your play' : 'Your lead';
}

export function pushNotices(previous: MatchState | null, next: MatchState): Notice[] {
  const notices = new Map<string, Notice>();
  const game = next.currentGame;
  const humans = next.players.map((p) => p.playerId).filter((id) => !isBot(id));
  const add = (playerId: string, kind: NoticeKind, title: string, body: string) =>
    notices.set(playerId, { playerId, kind, title, body, matchId: next.id });

  const dealt = isDealt(next);
  const justDealt = dealt && (previous === null || !isDealt(previous));
  const sameGame = previous?.currentGame.id === game.id;

  // The game has started: the table just filled and the first hand was dealt. A rematch, which
  // arrives already dealt (no previous), says nothing of it.
  if (justDealt && previous !== null) {
    for (const id of humans) add(id, 'started', 'Game on', 'All four seats are taken and the first hand is dealt.');
  }

  // The hand was just decided.
  const decided = gameWinningTeam(game) !== null;
  if (sameGame && decided && gameWinningTeam(previous!.currentGame) === null) {
    for (const id of humans) {
      if (next.winningTeam != null) add(id, 'matchOver', 'Match over', 'See how it ended, or ask for a rematch.');
      else add(id, 'handOver', 'Hand over', 'Ready up for the next hand.');
    }
  }

  // Someone's turn has come round: it moved, or a hand was just dealt (an undealt game already
  // names who'll go first). Not once the hand is decided: playing it out is optional.
  const current = game.currentPlayerId;
  const turnMoved = justDealt || !sameGame || previous!.currentGame.currentPlayerId !== current;
  if (dealt && !decided && current != null && !isBot(current) && turnMoved) {
    add(current, 'turn', turnTitle(game), `${game.name} is waiting on you.`);
  }

  return [...notices.values()];
}
