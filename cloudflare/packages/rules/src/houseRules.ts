// The house rules a custom table's creator picks (#117). Stored on the match and copied onto each
// hand it deals, so the guards that only see a `Game` (validation.ts, the bot) can read them.
// Absent means these defaults, which are the rules every other mode plays by.
import { ValidationError } from './errors';

export type LowRule = 'off' | 'on' | 'forcedOnly';
export type AllPassRule = 'forceLast' | 'redeal';

export interface HouseRules {
  // Whether the winning bidder may name a Low trump: never, at any bid of 42+, or only when they
  // were forced to bid (the other three all passed). Low always needs a bid of at least 42.
  low: LowRule;
  plunge: boolean;
  // When the first three pass: the last player must bid, or (redeal) they may pass too and new
  // hands are dealt, opened by the same player.
  allPass: AllPassRule;
  marksToWin: number;
}

export const DEFAULT_HOUSE_RULES: HouseRules = { low: 'on', plunge: true, allPass: 'forceLast', marksToWin: 7 };
export const MIN_MARKS_TO_WIN = 1;
export const MAX_MARKS_TO_WIN = 21;

export function houseRules(x: { rules?: Partial<HouseRules> }): HouseRules {
  return { ...DEFAULT_HOUSE_RULES, ...x.rules };
}

export function isDefaultHouseRules(rules: Partial<HouseRules> | undefined): boolean {
  const r = houseRules({ rules });
  return (
    r.low === DEFAULT_HOUSE_RULES.low &&
    r.plunge === DEFAULT_HOUSE_RULES.plunge &&
    r.allPass === DEFAULT_HOUSE_RULES.allPass &&
    r.marksToWin === DEFAULT_HOUSE_RULES.marksToWin
  );
}

const LOW_RULES: LowRule[] = ['off', 'on', 'forcedOnly'];
const ALL_PASS_RULES: AllPassRule[] = ['forceLast', 'redeal'];

function invalid(detail: string): never {
  throw new ValidationError('Invalid house rules', detail);
}

// Checks rules from a request, filling in defaults for anything left out.
export function assertValidHouseRules(input: unknown): HouseRules {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid('House rules must be an object.');
  const given = input as Record<string, unknown>;
  const rules = { ...DEFAULT_HOUSE_RULES, ...given } as Record<string, unknown>;

  if (!LOW_RULES.includes(rules.low as LowRule)) invalid(`\`low\` must be one of ${LOW_RULES.join(', ')}.`);
  if (typeof rules.plunge !== 'boolean') invalid('`plunge` must be true or false.');
  if (!ALL_PASS_RULES.includes(rules.allPass as AllPassRule)) {
    invalid(`\`allPass\` must be one of ${ALL_PASS_RULES.join(', ')}.`);
  }
  const marks = rules.marksToWin;
  if (typeof marks !== 'number' || !Number.isInteger(marks) || marks < MIN_MARKS_TO_WIN || marks > MAX_MARKS_TO_WIN) {
    invalid(`\`marksToWin\` must be a whole number from ${MIN_MARKS_TO_WIN} to ${MAX_MARKS_TO_WIN}.`);
  }
  if (rules.low === 'forcedOnly' && rules.allPass === 'redeal') {
    invalid('Some options aren\'t available when forced bidding is disabled: Low can\'t be limited to a forced bid when everyone passing reshuffles.');
  }

  return {
    low: rules.low as LowRule,
    plunge: rules.plunge as boolean,
    allPass: rules.allPass as AllPassRule,
    marksToWin: marks as number,
  };
}
