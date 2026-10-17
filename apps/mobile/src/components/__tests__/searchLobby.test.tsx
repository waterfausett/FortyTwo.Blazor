import { AccessibilityInfo } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { StatsSummary } from '@fortytwo/api-types';
import { LIVE_FILL_MS } from '@fortytwo/rules';
import { LOBBY_CARD_MS, SEARCH_TIPS, lobbyCards, type LobbyRoster } from '@fortytwo/client';
import { SearchLobby } from '../SearchLobby';

const STATS: StatsSummary = {
  played: 23, won: 14, lost: 9, marksWon: 131, bidsWon: 41, bidsMade: 30, bidsSet: 11, averagePointsBid: 32.4,
  marksBids: 9, favoriteTrump: { trump: 'sixes', times: 12 }, bestPartner: { user: { user_id: 'gj', displayName: 'Grandma Jo' }, won: 7, lost: 2 },
};
const NAMES: Record<string, string> = { me: 'Me', jo: 'Grandma Jo' };
const nameOf = (id: string) => NAMES[id] ?? null;
const roster = (us: [string | null, string | null], them: [string | null, string | null], seated = true): LobbyRoster => ({ us, them, seated });

function props(overrides: Partial<Parameters<typeof SearchLobby>[0]> = {}): Parameters<typeof SearchLobby>[0] {
  return {
    roster: roster(['me', null], ['jo', null]),
    viewerId: 'me',
    nameOf,
    online: 14,
    elapsedMs: LIVE_FILL_MS - 93_000,
    full: false,
    cards: lobbyCards(undefined),
    onStartWithBots: jest.fn(),
    startDisabled: false,
    onCancel: jest.fn(),
    cancelDisabled: false,
    ...overrides,
  };
}

// Each test's spies, put back after it: restoreAllMocks would also strip the jest preset's own
// AccessibilityInfo mocks.
const spies: { mockRestore: () => void }[] = [];
const track = <T extends { mockRestore: () => void }>(s: T): T => (spies.push(s), s);

describe('SearchLobby', () => {
  afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

  it('shows the heading, online count, bar time and roster by team', async () => {
    await render(<SearchLobby {...props()} />);
    expect(screen.getByText('Finding players')).toBeTruthy();
    expect(screen.getByText('14 online')).toBeTruthy();
    expect(screen.getByText('1:33 🤖')).toBeTruthy();
    expect(screen.getByText('Us')).toBeTruthy();
    expect(screen.getByText('Them')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Grandma Jo')).toBeTruthy();
    expect(screen.getByText('Partner · searching…')).toBeTruthy();
    expect(screen.getAllByText('Searching…')).toHaveLength(1);
  });

  it('has no You or Partner row for a viewer without a seat', async () => {
    await render(<SearchLobby {...props({ roster: roster([null, null], ['jo', null], false), viewerId: 'stranger' })} />);
    expect(screen.queryByText('You')).toBeNull();
    expect(screen.queryByText(/Partner/)).toBeNull();
    expect(screen.getAllByText('Searching…')).toHaveLength(3);
  });

  it("leaves out the online count and the bar when they're unknown or off", async () => {
    await render(<SearchLobby {...props({ online: null, elapsedMs: null })} />);
    expect(screen.queryByText(/online/)).toBeNull();
    expect(screen.queryByText(/\d:\d\d 🤖/)).toBeNull();
  });

  it('says Table full once the table is full', async () => {
    await render(<SearchLobby {...props({ full: true })} />);
    expect(screen.getByText('Table full')).toBeTruthy();
    expect(screen.queryByText(/\d:\d\d 🤖/)).toBeNull();
  });

  it('Start with bots and Cancel call back', async () => {
    const p = props();
    await render(<SearchLobby {...p} />);
    await fireEvent.press(screen.getByText('Start with bots'));
    await fireEvent.press(screen.getByText('Cancel'));
    expect(p.onStartWithBots).toHaveBeenCalledTimes(1);
    expect(p.onCancel).toHaveBeenCalledTimes(1);
  });

  it('has no Start with bots without bots', async () => {
    await render(<SearchLobby {...props({ onStartWithBots: null })} />);
    expect(screen.queryByText('Start with bots')).toBeNull();
  });

  it('shows a tip first, with the stats page next', async () => {
    await render(<SearchLobby {...props({ cards: lobbyCards(STATS, SEARCH_TIPS) })} />);
    expect(screen.getAllByText('Did you know').length).toBeGreaterThan(0);
    expect(screen.getByText(SEARCH_TIPS[0])).toBeTruthy();
    expect(screen.getAllByText('Your stats').length).toBeGreaterThan(0);
    expect(screen.getByText('Played')).toBeTruthy();
    expect(screen.getByText('23')).toBeTruthy();
    expect(screen.getByText('Favorite trump')).toBeTruthy();
    expect(screen.getByText('Best partner')).toBeTruthy();
  });

  it('announces a player joining, not one leaving', async () => {
    const announce = track(jest.spyOn(AccessibilityInfo, 'announceForAccessibility')).mockImplementation(() => {});
    const view = await render(<SearchLobby {...props({ roster: roster(['me', null], [null, null]) })} />);
    expect(announce).not.toHaveBeenCalled();
    await view.rerender(<SearchLobby {...props({ roster: roster(['me', null], ['jo', null]) })} />);
    expect(announce).toHaveBeenCalledWith('Grandma Jo joined, 2 of 4');
    await view.rerender(<SearchLobby {...props({ roster: roster(['me', null], [null, null]) })} />);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("waits for a newcomer's name before announcing them", async () => {
    const announce = track(jest.spyOn(AccessibilityInfo, 'announceForAccessibility')).mockImplementation(() => {});
    const loading = (id: string) => (id === 'me' ? 'Me' : null);
    const view = await render(<SearchLobby {...props({ roster: roster(['me', null], [null, null]) })} />);
    await view.rerender(<SearchLobby {...props({ roster: roster(['me', null], ['jo', null]), nameOf: loading })} />);
    expect(announce).not.toHaveBeenCalled();
    await view.rerender(<SearchLobby {...props({ roster: roster(['me', null], ['jo', null]) })} />);
    expect(announce).toHaveBeenCalledWith('Grandma Jo joined, 2 of 4');
  });

  describe('the card', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const dots = () => screen.getAllByLabelText(/^Card \d+ of \d+$/);
    // The current card's index, read from its dot's label (the row shows only some of the dots).
    const selectedDot = () =>
      Number(/^Card (\d+)/.exec(dots().find((dot) => dot.props.accessibilityState?.selected)!.props.accessibilityLabel)![1]) - 1;

    it('shows a short row of dots that slides along with the card', async () => {
      track(jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled')).mockResolvedValue(false);
      await render(<SearchLobby {...props()} />);
      await act(async () => {});
      expect(dots()).toHaveLength(7);
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          jest.advanceTimersByTime(LOBBY_CARD_MS);
        });
      }
      expect(selectedDot()).toBe(5);
      expect(dots()).toHaveLength(7);
      expect(dots()[0].props.accessibilityLabel).toMatch(/^Card 3 of /);
    });

    it('moves to the next card on its own', async () => {
      track(jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled')).mockResolvedValue(false);
      await render(<SearchLobby {...props()} />);
      await act(async () => {});
      expect(selectedDot()).toBe(0);
      await act(async () => {
        jest.advanceTimersByTime(LOBBY_CARD_MS);
      });
      expect(selectedDot()).toBe(1);
    });

    it('stays put with reduce motion on', async () => {
      track(jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled')).mockResolvedValue(true);
      await render(<SearchLobby {...props()} />);
      await act(async () => {});
      await act(async () => {
        jest.advanceTimersByTime(LOBBY_CARD_MS * 2);
      });
      expect(selectedDot()).toBe(0);
    });
  });
});
