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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const { bidMock, setTrumpMock, playDominoMock, readyUpMock, getMatchMock, useMatchSocketMock } = vi.hoisted(() => ({
  bidMock: vi.fn(),
  setTrumpMock: vi.fn(),
  playDominoMock: vi.fn(),
  readyUpMock: vi.fn(),
  getMatchMock: vi.fn(),
  useMatchSocketMock: vi.fn(),
}));

vi.mock('../api/client', () => ({
  apiClient: () => ({
    bid: bidMock,
    setTrump: setTrumpMock,
    playDomino: playDominoMock,
    readyUp: readyUpMock,
    getMatch: getMatchMock,
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

beforeEach(() => {
  // The page always issues a `getMatch` REST query alongside `useMatchSocket` (CRITICAL finding
  // #2's initial-load fix) - give it a harmless default resolution so tests that don't care about
  // it (nearly all of them, since `useMatchSocketMock` already supplies the match state they
  // assert on) don't hang on an unresolved query or an unhandled-rejection warning.
  getMatchMock.mockResolvedValue(null);
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

  it("shows each team's cumulative COMPLETED-trick point value, not the in-progress trick's raw pips", () => {
    // trickValue = dominoes' pip-value sum + 1 base point (trick.ts). Deliberately NOT a round
    // number so a wrong formula (e.g. summing raw pips without the +1, or including the
    // in-progress trick) would produce a different, distinguishable total.
    const myTrick = {
      playerId: 'p1',
      team: Teams.TeamA,
      suit: Suit.Sixes,
      dominoes: [createDomino(5, 5), createDomino(2, 3), createDomino(0, 0), createDomino(1, 1)],
    };
    // dominoValue: (5,5)=10, (2,3)=5, (0,0)=0, (1,1)=0 -> sum 15, trickValue = 15 + 1 = 16.
    const opponentTrick = {
      playerId: 'p2',
      team: Teams.TeamB,
      suit: Suit.Sixes,
      dominoes: [createDomino(4, 1), createDomino(6, 4), createDomino(3, 2), createDomino(0, 0)],
    };
    // dominoValue: (4,1)=5, (6,4)=10, (3,2)=5, (0,0)=0 -> sum 20, trickValue = 20 + 1 = 21.
    const match = baseMatch(
      {},
      {
        bid: Bid.Thirty,
        biddingPlayerId: 'p1',
        trump: Suit.Sixes,
        currentPlayerId: 'p1',
        hands: [
          { playerId: 'p1', team: Teams.TeamA, dominoes: [createDomino(1, 2)], bid: Bid.Thirty },
          { playerId: 'p2', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
          { playerId: 'p3', team: Teams.TeamA, dominoes: [], bid: Bid.Pass },
          { playerId: 'p4', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
        ],
        tricks: [myTrick, opponentTrick],
        // A 5-point domino sitting in the trick still being played - if the badge summed this
        // in too (the pre-fix bug), "myTrickPoints" would read 21, not the correct 16.
        currentTrick: { playerId: null, team: null, suit: null, dominoes: [createDomino(5, 0), null, null, null] },
      }
    );
    useMatchSocketMock.mockReturnValue({ match, connected: true });

    const { container } = renderMatch();

    expect(container.querySelector('.player-team-tricks .badge')?.textContent).toBe('16');
    expect(container.querySelector('.opponent-tricks .badge')?.textContent).toBe('21');
  });

  // Regression test for IMPORTANT finding #6 from the final whole-branch review: the bidding UI
  // used to show as soon as `game.hands.some(h => h.bid == null)`, which is trivially true for a
  // solo creator's 1-hand match (a table that isn't full yet). The creator would bid immediately,
  // "completing" bidding for that 1-hand view - so when players 2-4 joined later and their fresh
  // (bid: null) hands were added, bidding never resumed (currentPlayerId had already moved on),
  // permanently deadlocking the match. Asserts the panel is gated on a full, dealt table.
  it('does NOT show the bidding panel before the table has 4 players and a real deal', () => {
    const soloMatch = baseMatch(
      { players: [{ playerId: 'p1', position: Positions.First, ready: true }] },
      {
        hands: [{ playerId: 'p1', team: Teams.TeamA, dominoes: [], bid: null }],
      }
    );
    useMatchSocketMock.mockReturnValue({ match: soloMatch, connected: true });

    renderMatch();

    expect(screen.queryByText(/select a bid/i)).toBeNull();
  });

  it('shows the bidding panel once the table has 4 players and hands are actually dealt', () => {
    const match = baseMatch(); // baseMatch already has 4 players and p1's hand dealt.
    useMatchSocketMock.mockReturnValue({ match, connected: true });

    renderMatch();

    expect(screen.getByText(/select a bid/i)).not.toBeNull();
  });

  // Regression test for CRITICAL finding #5 from the final whole-branch review: `readyUp` is the
  // ONLY mechanism that deals a new hand once the current one has a winner, but Match.tsx had zero
  // UI for it - so a match could play its first hand to completion and then simply never continue.
  describe('Ready Up', () => {
    function finishedHandMatch(): MatchState {
      // A finished game: TeamA (p1/p3) bid Thirty and won a single trick worth 31 (>= 30) - matches
      // matchEngine.test.ts's `finishedGame` fixture shape closely enough to trip `gameWinningTeam`.
      return baseMatch(
        {
          players: [
            { playerId: 'p1', position: Positions.First, ready: false },
            { playerId: 'p2', position: Positions.Second, ready: true },
            { playerId: 'p3', position: Positions.Third, ready: false },
            { playerId: 'p4', position: Positions.Fourth, ready: false },
          ],
        },
        {
          bid: Bid.Thirty,
          biddingPlayerId: 'p1',
          trump: Suit.Sixes,
          hands: [
            { playerId: 'p1', team: Teams.TeamA, dominoes: [], bid: Bid.Thirty },
            { playerId: 'p2', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
            { playerId: 'p3', team: Teams.TeamA, dominoes: [], bid: Bid.Pass },
            { playerId: 'p4', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
          ],
          tricks: [
            {
              playerId: 'p1',
              team: Teams.TeamA,
              suit: Suit.Sixes,
              dominoes: [createDomino(5, 0), createDomino(5, 5), createDomino(6, 4), createDomino(4, 1)],
            },
          ],
        }
      );
    }

    it('shows a Ready Up button once the current hand has a winner, and hides it once bidding is happening', () => {
      const finished = finishedHandMatch();
      useMatchSocketMock.mockReturnValue({ match: finished, connected: true });
      renderMatch();
      expect(screen.getByRole('button', { name: /ready up/i })).not.toBeNull();

      cleanup();

      const inProgress = baseMatch();
      useMatchSocketMock.mockReturnValue({ match: inProgress, connected: true });
      renderMatch();
      expect(screen.queryByRole('button', { name: /ready up/i })).toBeNull();
    });

    it('calls readyUp(matchId, true) when the Ready Up button is clicked', async () => {
      readyUpMock.mockResolvedValue({} as MatchState);
      const finished = finishedHandMatch();
      useMatchSocketMock.mockReturnValue({ match: finished, connected: true });

      renderMatch();

      fireEvent.click(screen.getByRole('button', { name: /ready up/i }));

      await waitFor(() => expect(readyUpMock).toHaveBeenCalledWith('match-1', true));
    });

    it("shows each player's ready/not-ready status", () => {
      const finished = finishedHandMatch();
      useMatchSocketMock.mockReturnValue({ match: finished, connected: true });

      renderMatch();

      const rows = screen.getAllByTestId('ready-status-row');
      expect(rows).toHaveLength(4);
      expect(rows.find((r) => r.textContent?.includes('p2'))?.textContent).toMatch(/ready$/i);
      expect(rows.find((r) => r.textContent?.includes('p1'))?.textContent).toMatch(/not ready/i);
    });
  });

  it("renders the other 3 players' status: id, remaining domino count, and a turn indicator", () => {
    const match = baseMatch(
      {},
      {
        currentPlayerId: 'p3',
        hands: [
          { playerId: 'p1', team: Teams.TeamA, dominoes: [createDomino(1, 2)], bid: null },
          { playerId: 'p2', team: Teams.TeamB, dominoes: [createDomino(3, 4), createDomino(5, 6)], bid: null },
          { playerId: 'p3', team: Teams.TeamA, dominoes: [createDomino(0, 1)], bid: null },
          { playerId: 'p4', team: Teams.TeamB, dominoes: [], bid: null },
        ],
      }
    );
    useMatchSocketMock.mockReturnValue({ match, connected: true });

    renderMatch();

    const remotePlayers = screen.getAllByTestId('remote-player');
    expect(remotePlayers).toHaveLength(3);

    // Shows each OTHER player's id (never "p1", the logged-in user) and their remaining count.
    expect(screen.getByText('p2')).not.toBeNull();
    expect(screen.getByText('2 dominoes')).not.toBeNull();
    expect(screen.getByText('p3')).not.toBeNull();
    expect(screen.getByText('1 dominoes')).not.toBeNull();
    expect(screen.queryByText('p1')).toBeNull();

    // p3 is the current player - their status should carry the "their turn" indicator class.
    const p3Row = remotePlayers.find((row) => row.textContent?.includes('p3'));
    const p2Row = remotePlayers.find((row) => row.textContent?.includes('p2'));
    expect(p3Row?.classList.contains('active')).toBe(true);
    expect(p2Row?.classList.contains('active')).toBe(false);
  });
});
