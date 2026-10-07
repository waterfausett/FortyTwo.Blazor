import { describe, expect, it } from 'vitest';
import { safeReturnTo } from './returnTo';

describe('safeReturnTo', () => {
  it('keeps an in-app path, query and hash included', () => {
    expect(safeReturnTo('/match/abc?seat=2#hand')).toBe('/match/abc?seat=2#hand');
  });

  it('falls back to the Lobby when there is no path to return to', () => {
    expect(safeReturnTo(undefined)).toBe('/');
    expect(safeReturnTo('')).toBe('/');
    expect(safeReturnTo(42)).toBe('/');
  });

  it('refuses anything that would leave the app', () => {
    expect(safeReturnTo('https://evil.example')).toBe('/');
    expect(safeReturnTo('//evil.example/x')).toBe('/');
  });
});
