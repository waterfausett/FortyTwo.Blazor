import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertPrefs } from './alertPrefs';
import type { TableCall } from './TurnAlerts';
import { TurnAlerts } from './TurnAlerts';

const { playChimeMock, prefs } = vi.hoisted(() => ({
  playChimeMock: vi.fn(),
  prefs: { current: { sound: 'away', desktop: false } as AlertPrefs },
}));
vi.mock('../ui/chime', () => ({ playChime: playChimeMock }));
vi.mock('./alertPrefs', () => ({ readAlertPrefs: () => prefs.current }));

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  title: string;
  options: NotificationOptions;
  constructor(title: string, options: NotificationOptions) {
    this.title = title;
    this.options = options;
    FakeNotification.instances.push(this);
  }
}

let hidden = false;
let focused = true;

function setAway(away: boolean): void {
  hidden = away;
  focused = !away;
}

function comeBack(): void {
  setAway(false);
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}

function favicon(): HTMLLinkElement {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;
}

const TURN: TableCall = { kind: 'turn', title: 'Your lead', body: 'Game 1 is waiting on you.' };
const HAND_OVER: TableCall = { kind: 'handOver', title: 'Hand over', body: 'Ready up for the next hand.' };

function renderAlerts(isMyTurn: boolean) {
  const view = render(<TurnAlerts call={isMyTurn ? TURN : null} tag="match-1" />);
  const setCall = (call: TableCall | null) => view.rerender(<TurnAlerts call={call} tag="match-1" />);
  return { ...view, setCall, setTurn: (next: boolean) => setCall(next ? TURN : null) };
}

beforeEach(() => {
  vi.useFakeTimers();
  setAway(false);
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />';
  document.title = 'Forty-Two';
  prefs.current = { sound: 'away', desktop: false };
  FakeNotification.permission = 'granted';
  FakeNotification.instances = [];
  vi.stubGlobal('Notification', FakeNotification);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  playChimeMock.mockReset();
});

describe('TurnAlerts', () => {
  it('stays quiet about the turn the page opened on', () => {
    setAway(true);
    prefs.current = { sound: 'always', desktop: true };
    renderAlerts(true);
    expect(playChimeMock).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toHaveLength(0);
    expect(document.title).toBe('Forty-Two');
  });

  describe('sound', () => {
    it("chimes when the turn starts while away, on 'away'", () => {
      const { setTurn } = renderAlerts(false);
      setAway(true);
      setTurn(true);
      expect(playChimeMock).toHaveBeenCalledTimes(1);
    });

    it("stays quiet while the player is looking, on 'away'", () => {
      const { setTurn } = renderAlerts(false);
      setTurn(true);
      expect(playChimeMock).not.toHaveBeenCalled();
    });

    it("chimes even while the player is looking, on 'always'", () => {
      prefs.current = { sound: 'always', desktop: false };
      const { setTurn } = renderAlerts(false);
      setTurn(true);
      expect(playChimeMock).toHaveBeenCalledTimes(1);
    });

    it("never chimes on 'off'", () => {
      prefs.current = { sound: 'off', desktop: false };
      const { setTurn } = renderAlerts(false);
      setAway(true);
      setTurn(true);
      expect(playChimeMock).not.toHaveBeenCalled();
    });

    it('chimes once per turn, not on every render of it', () => {
      const { setTurn } = renderAlerts(false);
      setAway(true);
      setTurn(true);
      setTurn(true);
      expect(playChimeMock).toHaveBeenCalledTimes(1);
      setTurn(false);
      setTurn(true);
      expect(playChimeMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('tab title and favicon', () => {
    it('flash while away until the player comes back', () => {
      const { setTurn } = renderAlerts(false);
      setAway(true);
      setTurn(true);
      expect(document.title).toBe('● Your lead');
      expect(favicon().getAttribute('href')).toBe('/favicon-turn.svg');
      act(() => vi.advanceTimersByTime(1000));
      expect(document.title).toBe('Forty-Two');
      act(() => vi.advanceTimersByTime(1000));
      expect(document.title).toBe('● Your lead');

      comeBack();
      expect(document.title).toBe('Forty-Two');
      expect(favicon().getAttribute('href')).toBe('/favicon.svg');
      act(() => vi.advanceTimersByTime(5000));
      expect(document.title).toBe('Forty-Two');
    });

    it('stop when the turn ends', () => {
      const { setTurn } = renderAlerts(false);
      setAway(true);
      setTurn(true);
      setTurn(false);
      expect(document.title).toBe('Forty-Two');
      expect(favicon().getAttribute('href')).toBe('/favicon.svg');
    });

    it('stop when the page goes away', () => {
      const { setTurn, unmount } = renderAlerts(false);
      setAway(true);
      setTurn(true);
      unmount();
      expect(document.title).toBe('Forty-Two');
      expect(favicon().getAttribute('href')).toBe('/favicon.svg');
    });

    it('stay put while the player is looking', () => {
      const { setTurn } = renderAlerts(false);
      setTurn(true);
      expect(document.title).toBe('Forty-Two');
      expect(favicon().getAttribute('href')).toBe('/favicon.svg');
    });
  });

  describe('what counts as a new call', () => {
    it('alerts again when a turn gives way to the hand being over', () => {
      prefs.current = { sound: 'away', desktop: true };
      const { setTurn, setCall } = renderAlerts(false);
      setAway(true);
      setTurn(true);
      setCall(HAND_OVER);
      expect(playChimeMock).toHaveBeenCalledTimes(2);
      expect(FakeNotification.instances.map((n) => n.title)).toEqual(['Your lead', 'Hand over']);
      expect(FakeNotification.instances[0].close).toHaveBeenCalled();
      expect(document.title).toBe('● Hand over');
    });

    it('stays quiet when the same call only changes its words (winning a trick, then leading the next)', () => {
      const { setTurn, setCall } = renderAlerts(false);
      setAway(true);
      setCall({ kind: 'turn', title: 'Your play', body: 'Game 1 is waiting on you.' });
      setTurn(true);
      expect(playChimeMock).toHaveBeenCalledTimes(1);
      expect(document.title).toBe('● Your play');
    });

    it('stays quiet about a hand already over when the page opened', () => {
      setAway(true);
      const { setCall } = renderAlerts(false);
      setCall(null);
      expect(playChimeMock).not.toHaveBeenCalled();
      const view = render(<TurnAlerts call={HAND_OVER} tag="match-2" />);
      expect(playChimeMock).not.toHaveBeenCalled();
      view.unmount();
    });
  });

  describe('desktop notification', () => {
    it('shows one while away when switched on and allowed', () => {
      prefs.current = { sound: 'away', desktop: true };
      const { setTurn } = renderAlerts(false);
      setAway(true);
      setTurn(true);
      expect(FakeNotification.instances).toHaveLength(1);
      const [shown] = FakeNotification.instances;
      expect(shown.title).toBe('Your lead');
      expect(shown.options).toMatchObject({ body: 'Game 1 is waiting on you.', tag: 'match-1' });
    });

    it('closes when the turn ends', () => {
      prefs.current = { sound: 'away', desktop: true };
      const { setTurn } = renderAlerts(false);
      setAway(true);
      setTurn(true);
      setTurn(false);
      expect(FakeNotification.instances[0].close).toHaveBeenCalled();
    });

    it('brings the tab forward when clicked', () => {
      prefs.current = { sound: 'away', desktop: true };
      const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {});
      const { setTurn } = renderAlerts(false);
      setAway(true);
      setTurn(true);
      FakeNotification.instances[0].onclick?.();
      expect(focusSpy).toHaveBeenCalled();
      expect(FakeNotification.instances[0].close).toHaveBeenCalled();
    });

    it('is not shown when switched off, not allowed, unsupported, or the player is looking', () => {
      const { setTurn } = renderAlerts(false);
      setAway(true);
      setTurn(true); // switched off
      setTurn(false);

      prefs.current = { sound: 'away', desktop: true };
      FakeNotification.permission = 'denied';
      setTurn(true);
      setTurn(false);

      FakeNotification.permission = 'granted';
      setAway(false);
      setTurn(true);
      setTurn(false);
      expect(FakeNotification.instances).toHaveLength(0);

      vi.stubGlobal('Notification', undefined);
      setAway(true);
      expect(() => setTurn(true)).not.toThrow();
    });
  });
});
