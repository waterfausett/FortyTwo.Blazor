import { describe, it, expect } from 'vitest';
import { DEFAULT_HOUSE_RULES, assertValidHouseRules, houseRules, isDefaultHouseRules } from './houseRules';
import { ValidationError } from './errors';

describe('houseRules', () => {
  it('is the defaults when nothing is stored', () => {
    expect(houseRules({})).toEqual({ low: 'on', plunge: true, allPass: 'forceLast', marksToWin: 7 });
    expect(DEFAULT_HOUSE_RULES).toEqual({ low: 'on', plunge: true, allPass: 'forceLast', marksToWin: 7 });
  });

  it('fills in whatever is missing', () => {
    expect(houseRules({ rules: { plunge: false } })).toEqual({ ...DEFAULT_HOUSE_RULES, plunge: false });
  });
});

describe('isDefaultHouseRules', () => {
  it('is true for nothing, an empty object, or the defaults spelled out', () => {
    expect(isDefaultHouseRules(undefined)).toBe(true);
    expect(isDefaultHouseRules({})).toBe(true);
    expect(isDefaultHouseRules({ ...DEFAULT_HOUSE_RULES })).toBe(true);
  });

  it('is false when any setting differs', () => {
    expect(isDefaultHouseRules({ marksToWin: 5 })).toBe(false);
    expect(isDefaultHouseRules({ low: 'off' })).toBe(false);
  });
});

describe('assertValidHouseRules', () => {
  it('fills in defaults for a partial object', () => {
    expect(assertValidHouseRules({ low: 'off' })).toEqual({ ...DEFAULT_HOUSE_RULES, low: 'off' });
    expect(assertValidHouseRules({})).toEqual(DEFAULT_HOUSE_RULES);
  });

  it('accepts every valid combination it should', () => {
    expect(assertValidHouseRules({ low: 'forcedOnly', plunge: false, allPass: 'forceLast', marksToWin: 21 })).toEqual({
      low: 'forcedOnly', plunge: false, allPass: 'forceLast', marksToWin: 21,
    });
    expect(assertValidHouseRules({ allPass: 'redeal', marksToWin: 1 }).marksToWin).toBe(1);
  });

  it.each([
    ['not an object', 'rules'],
    ['an array', []],
    ['null', null],
    ['an unknown low', { low: 'sometimes' }],
    ['a non-boolean plunge', { plunge: 'yes' }],
    ['an unknown allPass', { allPass: 'shrug' }],
    ['marksToWin 0', { marksToWin: 0 }],
    ['marksToWin 22', { marksToWin: 22 }],
    ['a fractional marksToWin', { marksToWin: 6.5 }],
    ['a string marksToWin', { marksToWin: '7' }],
    ['forcedOnly with redeal', { low: 'forcedOnly', allPass: 'redeal' }],
  ])('rejects %s', (_, input) => {
    expect(() => assertValidHouseRules(input)).toThrow(ValidationError);
  });
});
