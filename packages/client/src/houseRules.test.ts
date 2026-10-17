import { describe, expect, it } from 'vitest';
import { DEFAULT_HOUSE_RULES } from '@fortytwo/rules';
import { houseRuleLabels, houseRuleRows, marksToWin, setHouseRule } from './houseRules';

describe('houseRuleLabels', () => {
  it('says nothing about default rules', () => {
    expect(houseRuleLabels(undefined)).toEqual([]);
    expect(houseRuleLabels(DEFAULT_HOUSE_RULES)).toEqual([]);
  });

  it('names each setting that differs, in a fixed order', () => {
    expect(houseRuleLabels({ low: 'off', plunge: false, allPass: 'redeal', marksToWin: 5 })).toEqual([
      'No Low', 'No Plunge', 'Reshuffle on all pass', 'To 5 marks',
    ]);
    expect(houseRuleLabels({ low: 'forcedOnly' })).toEqual(['Low on forced bid only']);
    expect(houseRuleLabels({ marksToWin: 1 })).toEqual(['To 1 mark']);
  });
});

describe('houseRuleRows', () => {
  it('lists every setting, none custom on default rules', () => {
    const rows = houseRuleRows(undefined);
    expect(rows.map((r) => r.label)).toEqual(['Plunge', 'Low', 'When everyone passes', 'Marks to win']);
    expect(rows.some((r) => r.custom)).toBe(false);
  });

  it('marks the settings that differ', () => {
    const rows = houseRuleRows({ low: 'off', marksToWin: 11 });
    expect(rows.filter((r) => r.custom).map((r) => [r.label, r.value])).toEqual([
      ['Low', 'Not allowed'],
      ['Marks to win', '11'],
    ]);
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
