// House rules as both apps show and edit them: the short labels for the lobby row and the match
// screen, and the create form's one consistency rule. The rules themselves are @fortytwo/rules'.
import {
  DEFAULT_HOUSE_RULES,
  MAX_MARKS_TO_WIN,
  MIN_MARKS_TO_WIN,
  houseRules,
  type HouseRules,
} from '@fortytwo/rules';

// One label per setting that differs from the defaults, so a standard table shows nothing.
export function houseRuleLabels(rules: Partial<HouseRules> | undefined): string[] {
  const r = houseRules({ rules });
  const labels: string[] = [];
  if (r.low === 'off') labels.push('No Low');
  if (r.low === 'forcedOnly') labels.push('Low on forced bid only');
  if (!r.plunge) labels.push('No Plunge');
  if (r.allPass === 'redeal') labels.push('Reshuffle on all pass');
  if (r.marksToWin !== DEFAULT_HOUSE_RULES.marksToWin) labels.push(`To ${r.marksToWin} ${r.marksToWin === 1 ? 'mark' : 'marks'}`);
  return labels;
}

// The create form's change to one setting. Nobody is forced under redeal, so Low-only-when-forced
// becomes plain Low; marks to win stays in range.
export function setHouseRule(rules: HouseRules, patch: Partial<HouseRules>): HouseRules {
  const next = { ...rules, ...patch };
  if (next.allPass === 'redeal' && next.low === 'forcedOnly') next.low = 'on';
  next.marksToWin = Math.min(MAX_MARKS_TO_WIN, Math.max(MIN_MARKS_TO_WIN, Math.round(next.marksToWin)));
  return next;
}

export function marksToWin(match: { rules?: Partial<HouseRules> }): number {
  return houseRules(match).marksToWin;
}
