// Who may ask for a hint (#76): a seated player in a practice match (mode 'bots') on the standard
// rules the model learned, while bots are on, on their own turn of an open hand. Hints stay out of
// every match with another human in it.
import { assertIsMatchPlayer, isDefaultHouseRules, matchMode, ValidationError, type MatchState } from '@fortytwo/rules';
import { assertCanHint } from '@fortytwo/bot';
import { botsEnabled } from './bots';

export function assertHintable(match: MatchState, playerId: string, enabled: boolean): void {
  if (matchMode(match) !== 'bots') {
    throw new ValidationError('Practice matches only', 'Hints are only available in practice matches.');
  }
  if (!isDefaultHouseRules(match.rules)) {
    throw new ValidationError('Practice matches only', 'Hints need the standard rules.');
  }
  assertIsMatchPlayer(match, playerId);
  if (!enabled) throw new ValidationError('Hints are off', 'Hints are turned off right now.');
  assertCanHint(match, playerId);
}

// Whether hints are on (index.ts's HINTS_ENABLED): on unless it's 'false', and never while bots
// are off, since the bot's model gives the hint.
export function hintsEnabled(env: { BOTS_ENABLED?: string; HINTS_ENABLED?: string }): boolean {
  return botsEnabled(env) && env.HINTS_ENABLED !== 'false';
}

// Whether hints show their details (index.ts's HINT_DETAILS). Off by default.
export function hintDetailsEnabled(env: { HINT_DETAILS?: string }): boolean {
  return env.HINT_DETAILS === 'true';
}
