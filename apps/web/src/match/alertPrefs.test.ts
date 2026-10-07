import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAlertPrefs, writeAlertPrefs } from './alertPrefs';

// Node's own (file-less) localStorage global shadows jsdom's, leaving it undefined here - so each
// test gets an in-memory one.
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('alert prefs', () => {
  it('defaults to a chime only when away, with desktop notifications off', () => {
    expect(readAlertPrefs()).toEqual({ sound: 'away', desktop: false });
  });

  it('remembers what was written', () => {
    writeAlertPrefs({ sound: 'always', desktop: true });
    expect(readAlertPrefs()).toEqual({ sound: 'always', desktop: true });
  });

  it('falls back to the defaults for anything it does not recognize', () => {
    localStorage.setItem('fortytwo.turnAlerts', JSON.stringify({ sound: 'loud', desktop: 'yes' }));
    expect(readAlertPrefs()).toEqual({ sound: 'away', desktop: false });
    localStorage.setItem('fortytwo.turnAlerts', 'not json');
    expect(readAlertPrefs()).toEqual({ sound: 'away', desktop: false });
  });

  it('uses the defaults when storage is blocked', () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
    expect(() => writeAlertPrefs({ sound: 'off', desktop: false })).not.toThrow();
    expect(readAlertPrefs()).toEqual({ sound: 'away', desktop: false });
  });
});
