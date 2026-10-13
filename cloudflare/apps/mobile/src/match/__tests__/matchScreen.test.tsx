// The match screen in an Over the table game under way: watching while waiting for a seat, looking
// again when that wait comes to nothing, a seat taken by a bot, Leave game, and who took a seat.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Alert, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Positions, Teams, createDomino, type MatchState } from '@fortytwo/rules';
import { toastInfo } from '@/components/toast';
import MatchScreen from '../../app/match/[id]';

const mockRouter = { replace: jest.fn(), dismissTo: jest.fn(), push: jest.fn() };
const mockSocket = jest.fn();
const mockMe = { id: 'p1' };
const mockApi = {
  getMatch: jest.fn(() => new Promise(() => {})),
  getConfig: jest.fn().mockResolvedValue({ bots: false }),
  searchUsers: jest.fn((ids: string[]) => Promise.resolve(ids.map((id) => ({ user_id: id, displayName: id })))),
  poke: jest.fn(),
  play: jest.fn(),
  leaveMatch: jest.fn(),
};

jest.mock('expo-router', () => ({
  // Read when called: this factory runs before the test's own constants are set.
  router: {
    replace: (...args: unknown[]) => mockRouter.replace(...args),
    dismissTo: (...args: unknown[]) => mockRouter.dismissTo(...args),
    push: (...args: unknown[]) => mockRouter.push(...args),
  },
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: 'match-1' }),
}));
jest.mock('react-native-auth0', () => ({ useAuth0: () => ({ user: { sub: mockMe.id } }) }));
jest.mock('@/dev/devBypass', () => ({ DEV_BYPASS: false }));
jest.mock('@/dev/devMatches', () => ({ DEV_PLAYER_ID: 'dev' }));
jest.mock('@/api/useMatchSocket', () => ({ useMatchSocket: () => mockSocket() }));
jest.mock('@/api/useApi', () => ({ useApi: () => mockApi }));
jest.mock('@/api/useProfile', () => ({ useProfile: () => ({ data: undefined }) }));
jest.mock('@/api/presence', () => ({ useOnline: () => null }));
jest.mock('@/auth/useGetToken', () => ({ useGetToken: () => () => Promise.resolve('token') }));
jest.mock('@/notifications/push', () => ({ askOnceForPush: jest.fn() }));
jest.mock('@/linking/invite', () => ({ shareInvite: jest.fn() }));
jest.mock('@/components/toast', () => ({ toastInfo: jest.fn(), toastError: jest.fn() }));

const PLAYERS = [
  { playerId: 'p1', position: Positions.First, ready: true },
  { playerId: 'bot-1', position: Positions.Second, ready: true },
  { playerId: 'p3', position: Positions.Third, ready: true },
  { playerId: 'p4', position: Positions.Fourth, ready: true },
];

// A live game under way, bidding open, with a bot in the second seat.
function dealtLiveWithBots(overrides: Partial<MatchState> = {}, players = PLAYERS): MatchState {
  return {
    id: 'match-1',
    mode: 'live',
    createdOn: '2026-01-01T00:00:00.000Z',
    updatedOn: new Date().toISOString(),
    winningTeam: null,
    players,
    games: {},
    currentGame: {
      id: 'g1',
      name: 'Game 1',
      firstActionBy: players[0].playerId,
      bid: null,
      biddingPlayerId: null,
      trump: null,
      currentPlayerId: players[0].playerId,
      hands: [
        { playerId: players[0].playerId, team: Teams.TeamA, dominoes: [createDomino(1, 2), createDomino(3, 4)], bid: null },
        { playerId: players[1].playerId, team: Teams.TeamB, dominoes: [createDomino(5, 6)], bid: null },
        { playerId: players[2].playerId, team: Teams.TeamA, dominoes: [createDomino(0, 0)], bid: null },
        { playerId: players[3].playerId, team: Teams.TeamB, dominoes: [createDomino(0, 1)], bid: null },
      ],
      currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
      tricks: [],
    },
    ...overrides,
  } as MatchState;
}

function screenTree() {
  const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <MatchScreen />
    </SafeAreaProvider>
  );
}

let client: QueryClient;
async function renderScreen() {
  // No garbage-collection timers left behind once the test ends.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  const view = await render(<QueryClientProvider client={client}>{screenTree()}</QueryClientProvider>);
  return {
    ...view,
    rerender: async () => view.rerender(<QueryClientProvider client={client}>{screenTree()}</QueryClientProvider>),
  };
}

function socket(match: MatchState, extra: { connected?: boolean; deleted?: boolean } = {}) {
  mockSocket.mockReturnValue({ match, connected: true, reconnecting: false, deleted: false, ...extra });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMe.id = 'p1';
});

describe('Match screen, Over the table', () => {
  it('shows a claimant the table without a hand, with Cancel', async () => {
    mockMe.id = 'n1';
    mockApi.leaveMatch.mockResolvedValue(undefined);
    socket(dealtLiveWithBots({ claims: ['n1'] }));
    await renderScreen();

    expect(await screen.findByText("Joining a game in progress. You'll take a seat when this hand ends.")).toBeTruthy();
    expect(screen.getByLabelText('Table')).toBeTruthy();
    // The first seat's hand is face down, and nobody's dominoes are shown to play.
    expect(screen.getByLabelText('2 dominoes')).toBeTruthy();
    expect(screen.queryByLabelText('1-2')).toBeNull();
    expect(screen.queryByText('Pass')).toBeNull();
    expect(screen.queryByText('Pick a seat to join')).toBeNull();
    expect(screen.queryByText('Leave game')).toBeNull();

    await fireEvent.press(screen.getByText('Cancel'));
    await waitFor(() => expect(mockApi.leaveMatch).toHaveBeenCalledWith('match-1'));
  });

  it('searches again, once, when a claim is let go', async () => {
    mockMe.id = 'n1';
    mockApi.play.mockResolvedValue({ ...dealtLiveWithBots(), id: 'other' });
    socket(dealtLiveWithBots({ bumped: ['n1'] }), { connected: false, deleted: true });
    const view = await renderScreen();

    expect(await screen.findByText('That game ended - finding you another table…')).toBeTruthy();
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/match/other'));
    await view.rerender();
    expect(mockApi.play).toHaveBeenCalledTimes(1);
    expect(mockApi.play).toHaveBeenCalledWith('live');
    expect(toastInfo).not.toHaveBeenCalledWith('This match was deleted');
  });

  it('offers Find another when the search after a bump fails', async () => {
    mockMe.id = 'n1';
    mockApi.play.mockRejectedValueOnce(new Error('nope')).mockResolvedValue({ ...dealtLiveWithBots(), id: 'other' });
    socket(dealtLiveWithBots({ bumped: ['n1'] }));
    await renderScreen();

    await fireEvent.press(await screen.findByText('Find another'));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/match/other'));
  });

  it('tells a replaced player a bot took their seat', async () => {
    mockMe.id = 'n1';
    socket(dealtLiveWithBots({ replaced: ['n1'] }));
    await renderScreen();

    expect(await screen.findByText('A bot took your seat after you were away for a hand.')).toBeTruthy();
    await fireEvent.press(screen.getByText('Back to lobby'));
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/');
  });

  it('offers Leave game in an Over the table game under way, and not in a custom one', async () => {
    mockApi.leaveMatch.mockResolvedValue(undefined);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    socket(dealtLiveWithBots());
    const view = await renderScreen();

    await fireEvent.press(await screen.findByText('Leave game'));
    expect(alert).toHaveBeenCalledWith('Leave this game?', 'A bot takes your seat.', expect.any(Array));
    const buttons = alert.mock.calls[0][2] as AlertButton[];
    expect(buttons.map((b) => b.text)).toEqual(['Stay', 'Leave']);
    await act(async () => buttons[1].onPress?.());
    await waitFor(() => expect(mockApi.leaveMatch).toHaveBeenCalledWith('match-1'));
    alert.mockRestore();
    await view.unmount();

    const custom = dealtLiveWithBots({ mode: 'custom' });
    socket(custom);
    await renderScreen();
    await screen.findByLabelText('1-2');
    expect(screen.queryByText('Leave game')).toBeNull();
  });

  it('says who took a seat', async () => {
    socket(dealtLiveWithBots());
    const view = await renderScreen();
    await screen.findByLabelText('1-2');
    socket(dealtLiveWithBots({}, [PLAYERS[0], { playerId: 'p2', position: Positions.Second, ready: true }, PLAYERS[2], PLAYERS[3]]));
    await view.rerender();

    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("p2 took bot-1's seat"));
  });

  it("tells a claimant they're in when they take a seat", async () => {
    mockMe.id = 'n1';
    socket(dealtLiveWithBots({ claims: ['n1'] }));
    const view = await renderScreen();
    await screen.findByText(/Joining a game in progress/);
    socket(dealtLiveWithBots({}, [PLAYERS[0], { playerId: 'n1', position: Positions.Second, ready: true }, PLAYERS[2], PLAYERS[3]]));
    await view.rerender();

    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith("You're in", 'You took a seat - your first hand is dealt.'));
    expect(toastInfo).not.toHaveBeenCalledWith(expect.stringMatching(/took .*'s seat/));
  });
});
