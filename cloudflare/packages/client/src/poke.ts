// When to offer the Poke button: the player whose turn it is has sat on it a while (the Worker's
// MatchDO `poke` and poke.ts, which make the final call). Mid-hand only that player can change the
// match, so its `updatedOn` is when their turn began.
import { gameWinningTeam, isBot, type MatchState } from '@fortytwo/rules';
import { describeMatch } from './matchView';

// The Worker's POKE_IDLE_MS (apps/worker/src/poke.ts) is the same.
export const POKE_IDLE_MS = 30 * 60 * 1000;

// Who `myPlayerId` could poke once the turn has waited long enough: whoever the table is waiting
// on in a dealt, undecided hand, if that's someone else and not a bot. Null otherwise, including
// before the match loads or when I'm not seated.
export function pokeTarget(match: MatchState | null, myPlayerId: string | undefined): string | null {
  if (!match || !myPlayerId || !match.players.some((p) => p.playerId === myPlayerId)) return null;
  const target = match.currentGame.currentPlayerId;
  if (!describeMatch(match, myPlayerId).isTableReady || gameWinningTeam(match.currentGame) !== null) return null;
  if (target == null || target === myPlayerId || isBot(target)) return null;
  return target;
}

// Whether a poke that just reached `myPlayerId` still stands: the table is still waiting on them,
// in a hand that's still undecided. A screen also drops one that lands while the player's own move
// is in flight - the move the poke would be asking for.
export function isPokeCurrent(match: MatchState | null, myPlayerId: string | undefined): boolean {
  if (!match || !myPlayerId || !match.players.some((p) => p.playerId === myPlayerId)) return false;
  return (
    match.currentGame.currentPlayerId === myPlayerId &&
    describeMatch(match, myPlayerId).isTableReady &&
    gameWinningTeam(match.currentGame) === null
  );
}

// When the current turn can first be poked, in ms since the epoch.
export function pokeableAt(match: MatchState): number {
  return Date.parse(match.updatedOn) + POKE_IDLE_MS;
}

// Names the current turn, so a screen can remember it already poked it. Matches the Worker's
// pokeTurnKey, so a new turn - even the same player's again - can be poked afresh.
export function pokeTurnKey(match: MatchState): string {
  const game = match.currentGame;
  return `${game.id}:${game.currentPlayerId}:${match.updatedOn}`;
}
