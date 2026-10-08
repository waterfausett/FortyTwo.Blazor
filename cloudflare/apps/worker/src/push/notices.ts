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
//
// A notice says what happened, not how to show it: send.ts names the match by its teams from each
// recipient's side, which needs names this pure code doesn't have.
import {
  Teams,
  bidToPrettyString,
  gameWinningTeam,
  handSize,
  isBot,
  matchScores,
  teamForPosition,
  type Game,
  type MatchPlayerRef,
  type MatchState,
} from '@fortytwo/rules';

export type NoticeKind = 'turn' | 'handOver' | 'matchOver' | 'started' | 'poke';

export interface Notice {
  playerId: string;
  kind: NoticeKind;
  // What happened, in a few words: "Your bid", "Hand over".
  headline: string;
  // What happened, said in full, from the player's side: "We took the hand. Ready for the next
  // one?". Shown in the headline's place under a score, and after the headline otherwise.
  detail?: string;
  matchId: string;
  // Who sits where, to name the match by its teams.
  players: MatchPlayerRef[];
  // Each team's marks, or none when the score isn't worth telling: at the game on it's 0-0, and a
  // poke is about a turn, not how the match stands.
  marks?: Record<Teams, number>;
}

export function noticeFor(
  match: MatchState,
  playerId: string,
  kind: NoticeKind,
  headline: string,
  detail?: string
): Notice {
  const scores = matchScores(match);
  return {
    playerId,
    kind,
    headline,
    ...(detail != null && { detail }),
    matchId: match.id,
    players: match.players.map(({ playerId, position }) => ({ playerId, position })),
    ...(kind !== 'started' && kind !== 'poke' && { marks: { [Teams.TeamA]: scores[Teams.TeamA] ?? 0, [Teams.TeamB]: scores[Teams.TeamB] ?? 0 } }),
  };
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

// What the bidder won the bid with, once they're to name trump - if the hand says.
function bidDetail(game: Game): string | undefined {
  return game.trump == null && game.bid != null && game.hands.every((h) => h.bid != null)
    ? `You won the bid! (${bidToPrettyString(game.bid)})`
    : undefined;
}

export function pushNotices(previous: MatchState | null, next: MatchState): Notice[] {
  const notices = new Map<string, Notice>();
  const game = next.currentGame;
  const humans = next.players.map((p) => p.playerId).filter((id) => !isBot(id));
  const add = (playerId: string, kind: NoticeKind, headline: string, detail?: string) =>
    notices.set(playerId, noticeFor(next, playerId, kind, headline, detail));
  const teamOf = (id: string) => teamForPosition(next.players.find((p) => p.playerId === id)!.position);

  const dealt = isDealt(next);
  const justDealt = dealt && (previous === null || !isDealt(previous));
  const sameGame = previous?.currentGame.id === game.id;

  // The game has started: the table just filled and the first hand was dealt. A rematch, which
  // arrives already dealt (no previous), says nothing of it.
  if (justDealt && previous !== null) {
    for (const id of humans) add(id, 'started', 'Game on', "All four seats are taken and we're ready to go!");
  }

  // The hand was just decided. Each side hears who took it (or the match), as the match screen
  // says it.
  const handWinner = gameWinningTeam(game);
  const decided = handWinner !== null;
  if (sameGame && decided && gameWinningTeam(previous!.currentGame) === null) {
    for (const id of humans) {
      const ours = teamOf(id) === (next.winningTeam ?? handWinner);
      if (next.winningTeam != null) {
        add(id, 'matchOver', 'Match over', `${ours ? 'You won the match!' : 'They won the match.'} Up for a rematch?`);
      } else {
        add(id, 'handOver', 'Hand over', `${ours ? 'We took the hand.' : 'They took the hand.'} Ready for the next one?`);
      }
    }
  }

  // Someone's turn has come round: it moved, or a hand was just dealt (an undealt game already
  // names who'll go first). Not once the hand is decided: playing it out is optional.
  const current = game.currentPlayerId;
  const turnMoved = justDealt || !sameGame || previous!.currentGame.currentPlayerId !== current;
  if (dealt && !decided && current != null && !isBot(current) && turnMoved) {
    add(current, 'turn', turnTitle(game), bidDetail(game));
  }

  return [...notices.values()];
}
