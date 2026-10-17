import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { StatsSummary } from '@fortytwo/api-types';
import { LIVE_FILL_MS } from '@fortytwo/rules';
import { LOBBY_CARD_MS, SEARCH_TIPS, lobbyCards, type LobbyRoster } from '@fortytwo/client';
import { SearchLobby } from './SearchLobby';

const STATS: StatsSummary = {
  played: 23, won: 14, lost: 9, marksWon: 131, bidsWon: 41, bidsMade: 30, bidsSet: 11, averagePointsBid: 32.4,
  marksBids: 9, favoriteTrump: { trump: 'sixes', times: 12 }, bestPartner: { user: { user_id: 'gj', displayName: 'Grandma Jo' }, won: 7, lost: 2 },
};
const NAMES: Record<string, string> = { me: 'Me', jo: 'Grandma Jo' };
const nameOf = (id: string) => NAMES[id] ?? null;
const roster = (us: [string | null, string | null], them: [string | null, string | null], seated = true): LobbyRoster => ({ us, them, seated });

type Props = Parameters<typeof SearchLobby>[0];
function props(overrides: Partial<Props> = {}): Props {
  return {
    roster: roster(['me', null], ['jo', null]),
    viewerId: 'me',
    nameOf,
    online: 14,
    elapsedMs: LIVE_FILL_MS - 93_000,
    full: false,
    cards: lobbyCards(undefined),
    onStartWithBots: vi.fn(),
    startDisabled: false,
    onCancel: vi.fn(),
    cancelDisabled: false,
    ...overrides,
  };
}

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe('SearchLobby', () => {
  beforeEach(() => stubReducedMotion(false));
  afterEach(() => vi.unstubAllGlobals());

  it('shows the heading, online count, bar time and roster by team', () => {
    render(<SearchLobby {...props()} />);
    expect(screen.getByRole('heading', { name: 'Finding players' })).toBeTruthy();
    expect(screen.getByText('14 online')).toBeTruthy();
    expect(screen.getByText('1:33 🤖')).toBeTruthy();
    expect(screen.getByText('Us')).toBeTruthy();
    expect(screen.getByText('Them')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Grandma Jo')).toBeTruthy();
    expect(screen.getByText('Partner · searching…')).toBeTruthy();
    expect(screen.getAllByText('Searching…')).toHaveLength(1);
  });

  it('has no You or Partner row for a viewer without a seat', () => {
    render(<SearchLobby {...props({ roster: roster([null, null], ['jo', null], false), viewerId: 'stranger' })} />);
    expect(screen.queryByText('You')).toBeNull();
    expect(screen.queryByText(/Partner/)).toBeNull();
    expect(screen.getAllByText('Searching…')).toHaveLength(3);
  });

  it("leaves out the online count and the bar when they're unknown or off", () => {
    render(<SearchLobby {...props({ online: null, elapsedMs: null })} />);
    expect(screen.queryByText(/online/)).toBeNull();
    expect(screen.queryByText(/\d:\d\d 🤖/)).toBeNull();
  });

  it('says Table full once the table is full', () => {
    render(<SearchLobby {...props({ full: true })} />);
    expect(screen.getByText('Table full')).toBeTruthy();
    expect(screen.queryByText(/\d:\d\d 🤖/)).toBeNull();
  });

  it('Start with bots and Cancel search call back', () => {
    const p = props();
    render(<SearchLobby {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start with bots' }));
    fireEvent.click(screen.getByRole('button', { name: /cancel search/i }));
    expect(p.onStartWithBots).toHaveBeenCalledTimes(1);
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('has no Start with bots without bots', () => {
    render(<SearchLobby {...props({ onStartWithBots: null })} />);
    expect(screen.queryByRole('button', { name: 'Start with bots' })).toBeNull();
  });

  it('shows a tip first, with the stats page next', () => {
    render(<SearchLobby {...props({ cards: lobbyCards(STATS, SEARCH_TIPS) })} />);
    expect(screen.getAllByText('Did you know').length).toBeGreaterThan(0);
    expect(screen.getByText(SEARCH_TIPS[0])).toBeTruthy();
    expect(screen.getAllByText('Your stats').length).toBeGreaterThan(0);
    expect(screen.getByText('Played')).toBeTruthy();
    expect(screen.getByText('23')).toBeTruthy();
    expect(screen.getByText('Favorite trump')).toBeTruthy();
    expect(screen.getByText('Best partner')).toBeTruthy();
  });

  it('announces a player joining, not one leaving', () => {
    const view = render(<SearchLobby {...props({ roster: roster(['me', null], [null, null]) })} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    view.rerender(<SearchLobby {...props({ roster: roster(['me', null], ['jo', null]) })} />);
    expect(status.textContent).toBe('Grandma Jo joined, 2 of 4');
    view.rerender(<SearchLobby {...props({ roster: roster(['me', null], [null, null]) })} />);
    expect(status.textContent).toBe('Grandma Jo joined, 2 of 4');
  });

  it("waits for a newcomer's name before announcing them", () => {
    const loading = (id: string) => (id === 'me' ? 'Me' : null);
    const view = render(<SearchLobby {...props({ roster: roster(['me', null], [null, null]) })} />);
    const status = screen.getByRole('status');
    view.rerender(<SearchLobby {...props({ roster: roster(['me', null], ['jo', null]), nameOf: loading })} />);
    expect(status.textContent).toBe('');
    view.rerender(<SearchLobby {...props({ roster: roster(['me', null], ['jo', null]) })} />);
    expect(status.textContent).toBe('Grandma Jo joined, 2 of 4');
  });

  describe('the card', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const current = () =>
      screen.getAllByRole('button', { name: /^Card \d+ of \d+$/ }).findIndex((dot) => dot.getAttribute('aria-current') === 'true');

    it('moves to the next card on its own', () => {
      render(<SearchLobby {...props()} />);
      expect(current()).toBe(0);
      act(() => {
        vi.advanceTimersByTime(LOBBY_CARD_MS);
      });
      expect(current()).toBe(1);
    });

    it('stays put with reduced motion', () => {
      stubReducedMotion(true);
      render(<SearchLobby {...props()} />);
      act(() => {
        vi.advanceTimersByTime(LOBBY_CARD_MS * 2);
      });
      expect(current()).toBe(0);
    });

    it('goes to a card when its dot is pressed, and holds there', () => {
      render(<SearchLobby {...props()} />);
      fireEvent.click(screen.getByRole('button', { name: /^Card 3 of / }));
      expect(current()).toBe(2);
      act(() => {
        vi.advanceTimersByTime(LOBBY_CARD_MS - 1);
      });
      expect(current()).toBe(2);
    });
  });
});
