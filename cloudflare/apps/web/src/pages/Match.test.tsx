// Match.tsx composes BiddingPanel/Hand/TrickDisplay over live `useMatchSocket` state plus
// `apiClient()` bid/setTrump/playDomino mutations. `useMatchSocket` and `apiClient` are both
// mocked at the module level (matching Lobby.test.tsx's established pattern) so each test
// controls the match snapshot and mutation behavior directly, without a real WebSocket or HTTP
// call. `react-router-dom`'s `useParams` is overridden to supply a fixed `matchId`, and
// `@auth0/auth0-react`'s `useAuth0` is mocked to identify "me" as player `p1` (mirroring how the
// real Worker derives `playerId` from Auth0's `user.sub` - see apps/worker/src/routes/matches.ts).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Bid, createDomino, Positions, Suit, Teams, type Domino, type MatchState } from '@fortytwo/rules';
import { Match } from './Match';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    // See Hand.test.tsx for why this is a cast rather than a direct assignment.
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  }
});

const { bidMock, setTrumpMock, playDominoMock, useMatchSocketMock } = vi.hoisted(() => ({
  bidMock: vi.fn(),
  setTrumpMock: vi.fn(),
  playDominoMock: vi.fn(),
  useMatchSocketMock: vi.fn(),
}));

vi.mock('../api/client', () => ({
  apiClient: () => ({
    bid: bidMock,
    setTrump: setTrumpMock,
    playDomino: playDominoMock,
  }),
}));

vi.mock('../api/useMatchSocket', () => ({
  useMatchSocket: useMatchSocketMock,
}));

vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({
    user: { sub: 'p1' },
    getAccessTokenSilently: vi.fn(async () => 'test-token'),
  }),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useParams: () => ({ matchId: 'match-1' }) };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderMatch() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Match />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const PLAYERS = [
  { playerId: 'p1', position: Positions.First, ready: true },
  { playerId: 'p2', position: Positions.Second, ready: true },
  { playerId: 'p3', position: Positions.Third, ready: true },
  { playerId: 'p4', position: Positions.Fourth, ready: true },
];

function baseMatch(overrides: Partial<MatchState> = {}, gameOverrides: Partial<MatchState['currentGame']> = {}): MatchState {
  return {
    id: 'match-1',
    createdOn: '2026-01-01T00:00:00.000Z',
    updatedOn: '2026-01-01T00:00:00.000Z',
    winningTeam: null,
    players: PLAYERS,
    games: {},
    currentGame: {
      id: 'g1',
      name: 'Game 1',
      firstActionBy: 'p1',
      bid: null,
      biddingPlayerId: null,
      trump: null,
      currentPlayerId: 'p1',
      hands: [
        { playerId: 'p1', team: Teams.TeamA, dominoes: [createDomino(1, 2), createDomino(3, 4)], bid: null },
        { playerId: 'p2', team: Teams.TeamB, dominoes: [], bid: null },
        { playerId: 'p3', team: Teams.TeamA, dominoes: [], bid: null },
        { playerId: 'p4', team: Teams.TeamB, dominoes: [], bid: null },
      ],
      currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
      tricks: [],
      ...gameOverrides,
    },
    ...overrides,
  };
}

describe('Match', () => {
  it('shows BiddingPanel and hides Hand play interaction during the bidding phase', () => {
    const match = baseMatch();
    useMatchSocketMock.mockReturnValue({ match, connected: true });

    renderMatch();

    expect(screen.getByText(/select a bid/i)).not.toBeNull();

    // Hand still renders the player's dominoes, but not as clickable/playable.
    const tiles = screen.getAllByTestId('domino');
    expect(tiles.length).toBe(2);
    for (const tile of tiles) {
      expect(tile.classList.contains('clickable')).toBe(false);
    }

    fireEvent.click(tiles[0]);
    expect(playDominoMock).not.toHaveBeenCalled();
  });

  it('shows Hand + TrickDisplay during the playing phase and plays a domino on click', async () => {
    playDominoMock.mockResolvedValue({} as MatchState);
    const domino: Domino = createDomino(1, 2);
    const match = baseMatch(
      {},
      {
        bid: Bid.Thirty,
        biddingPlayerId: 'p1',
        trump: Suit.Sixes,
        currentPlayerId: 'p1',
        hands: [
          { playerId: 'p1', team: Teams.TeamA, dominoes: [domino, createDomino(3, 4)], bid: Bid.Thirty },
          { playerId: 'p2', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
          { playerId: 'p3', team: Teams.TeamA, dominoes: [], bid: Bid.Pass },
          { playerId: 'p4', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
        ],
      }
    );
    useMatchSocketMock.mockReturnValue({ match, connected: true });

    renderMatch();

    expect(screen.getByLabelText(/current trick/i)).not.toBeNull();
    const tiles = screen.getAllByTestId('domino');
    expect(tiles.length).toBe(2);

    fireEvent.click(tiles[0]);

    await waitFor(() => expect(playDominoMock).toHaveBeenCalledWith('match-1', { top: domino.top, bottom: domino.bottom }));
  });

  it('calls bid with the right Bid value when a bid button is clicked', async () => {
    bidMock.mockResolvedValue({} as MatchState);
    const match = baseMatch();
    useMatchSocketMock.mockReturnValue({ match, connected: true });

    renderMatch();

    fireEvent.click(screen.getByRole('button', { name: /^30$/ }));

    await waitFor(() => expect(bidMock).toHaveBeenCalledWith('match-1', Bid.Thirty));
  });

  it('surfaces a ValidationError-shaped API error as a visible inline banner', async () => {
    playDominoMock.mockRejectedValue(new Error('You must follow suit!: If you have a Six, you must play it'));
    const domino: Domino = createDomino(1, 2);
    const match = baseMatch(
      {},
      {
        bid: Bid.Thirty,
        biddingPlayerId: 'p1',
        trump: Suit.Sixes,
        currentPlayerId: 'p1',
        hands: [
          { playerId: 'p1', team: Teams.TeamA, dominoes: [domino], bid: Bid.Thirty },
          { playerId: 'p2', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
          { playerId: 'p3', team: Teams.TeamA, dominoes: [], bid: Bid.Pass },
          { playerId: 'p4', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
        ],
      }
    );
    useMatchSocketMock.mockReturnValue({ match, connected: true });

    renderMatch();

    fireEvent.click(screen.getByTestId('domino'));

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/you must follow suit/i);
  });

  it("disables bidding when it is not this player's turn", () => {
    const match = baseMatch({}, { currentPlayerId: 'p2' });
    useMatchSocketMock.mockReturnValue({ match, connected: true });

    renderMatch();

    // Not this player's turn to bid, so no BiddingPanel section should render at all.
    expect(screen.queryByText(/select a bid/i)).toBeNull();
  });
});
