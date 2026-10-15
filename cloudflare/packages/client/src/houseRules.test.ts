import { describe, expect, it } from 'vitest';
import { DEFAULT_HOUSE_RULES } from '@fortytwo/rules';
import { houseRuleLabels, marksToWin, setHouseRule } from './houseRules';

describe('houseRuleLabels', () => {
  it('says nothing about default rules', () => {
    expect(houseRuleLabels(undefined)).toEqual([]);
    expect(houseRuleLabels(DEFAULT_HOUSE_RULES)).toEqual([]);
  });

  it('names each setting that differs, in a fixed order', () => {
    expect(houseRuleLabels({ low: 'off', plunge: false, allPass: 'redeal', marksToWin: 5 })).toEqual([
      'No Low', 'No Plunge', 'Redeal on all pass', 'To 5 marks',
    ]);
    expect(houseRuleLabels({ low: 'forcedOnly' })).toEqual(['Low only when forced']);
    expect(houseRuleLabels({ marksToWin: 1 })).toEqual(['To 1 mark']);
  });
});

describe('setHouseRule', () => {
  it('moves forcedOnly Low to on when redeal is picked', () => {
    const rules = { ...DEFAULT_HOUSE_RULES, low: 'forcedOnly' as const };
    expect(setHouseRule(rules, { allPass: 'redeal' })).toEqual({ ...DEFAULT_HOUSE_RULES, allPass: 'redeal' });
  });

  it('keeps marks to win from 1 to 21', () => {
    expect(setHouseRule(DEFAULT_HOUSE_RULES, { marksToWin: 0 }).marksToWin).toBe(1);
    expect(setHouseRule(DEFAULT_HOUSE_RULES, { marksToWin: 22 }).marksToWin).toBe(21);
  });
});

describe('marksToWin', () => {
  it('is 7 without rules, or the house number', () => {
    expect(marksToWin({})).toBe(7);
    expect(marksToWin({ rules: { ...DEFAULT_HOUSE_RULES, marksToWin: 11 } })).toBe(11);
  });
});
