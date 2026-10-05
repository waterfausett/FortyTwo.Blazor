// The rules for poking the player whose turn it is (MatchDO's `poke`): who may poke whom, and when.
// Pure, apart from the clock it's handed, so it lives outside the DO.
//
// A turn can be poked once it's been waiting POKE_IDLE_MS. Mid-hand only the player whose turn it
// is can change the match, so its `updatedOn` is when their turn began.
import { ValidationError, assertIsMatchPlayer, gameWinningTeam, isBot, type MatchState } from '@fortytwo/rules';
import { isDealt, type Notice } from './push/notices';

// @fortytwo/client's POKE_IDLE_MS is the same, so the Poke button shows when a poke would be taken.
export const POKE_IDLE_MS = 30 * 60 * 1000;

// Names the turn a poke is for. Each turn gets a new one - the turn moved on, a new hand was dealt,
// or (when a trick's winner leads the next) the same player's turn began again - so each can be
// poked once.
export function pokeTurnKey(match: MatchState): string {
  const game = match.currentGame;
  return `${game.id}:${game.currentPlayerId}:${match.updatedOn}`;
}

// The player `pokerId` may poke right now, or why they can't: they must be seated, and the turn
// must be someone else's, a human's, in a dealt hand that's still undecided (the turns push
// notices are sent for), and have waited long enough.
export function pokeTarget(match: MatchState, pokerId: string, now: number): string {
  assertIsMatchPlayer(match, pokerId);
  const target = match.currentGame.currentPlayerId;
  if (!isDealt(match) || gameWinningTeam(match.currentGame) !== null || target == null) {
    throw new ValidationError('Nobody to poke', "The table isn't waiting on anyone's turn.");
  }
  if (target === pokerId) throw new ValidationError("It's your turn", 'The table is waiting on you.');
  if (isBot(target)) throw new ValidationError('Nobody to poke', 'Bots never keep the table waiting.');
  if (now - Date.parse(match.updatedOn) < POKE_IDLE_MS) {
    throw new ValidationError('Too soon to poke', 'A turn can be poked once it has waited 30 minutes.');
  }
  return target;
}

export function pokeNotice(match: MatchState, target: string): Notice {
  return {
    playerId: target,
    kind: 'poke',
    title: "You've been poked",
    body: `${match.currentGame.name} is waiting on you.`,
    matchId: match.id,
  };
}
