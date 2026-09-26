// Match.tsx composes BiddingPanel/Hand/TrickDisplay over live `useMatchSocket` state plus
// `apiClient()` bid/setTrump/playDomino mutations. `useMatchSocket` and `apiClient` are both
// mocked at the module level (matching Lobby.test.tsx's established pattern) so each test
// controls the match snapshot and mutation behavior directly, without a real WebSocket or HTTP
// call. `react-router-dom`'s `useParams` is overridden to supply a fixed `matchId`, and
// `@auth0/auth0-react`'s `useAuth0` is mocked to identify "me" as player `p1` (mirroring how the
// real Worker derives `playerId` from Auth0's `user.sub` - see apps/worker/src/routes/matches.ts).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bid, createDomino, Positions, Suit, Teams, type Domino, type MatchState, type Trick } from '@fortytwo/rules';
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

const {
  bidMock,
  setTrumpMock,
  playDominoMock,
  readyUpMock,
  getMatchMock,
  searchUsersMock,
  useMatchSocketMock,
  toastErrorMock,
  currentUserId,
} =
  vi.hoisted(() => ({
    bidMock: vi.fn(),
    setTrumpMock: vi.fn(),
    playDominoMock: vi.fn(),
    readyUpMock: vi.fn(),
    getMatchMock: vi.fn(),
    searchUsersMock: vi.fn(),
    useMatchSocketMock: vi.fn(),
    toastErrorMock: vi.fn(),
    // Mutable so individual tests can play as someone other than 'p1' (needed for the
    // isTableReady deadlock regression test below, which needs 'me' to be a player whose hand
    // ISN'T the one that triggers the bug).
    currentUserId: { value: 'p1' },
  }));

vi.mock('../api/client', () => ({
  apiClient: () => ({
    bid: bidMock,
    setTrump: setTrumpMock,
    playDomino: playDominoMock,
    readyUp: readyUpMock,
    getMatch: getMatchMock,
    searchUsers: searchUsersMock,
  }),
}));

vi.mock('../ui/toast', () => ({
  toastError: toastErrorMock,
}));

vi.mock('../api/useMatchSocket', () => ({
  useMatchSocket: useMatchSocketMock,
}));

vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({
    user: { sub: currentUserId.value },
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
  // No display names by default, so seats show raw player ids ('p2', ...) as most tests expect.
  searchUsersMock.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  currentUserId.value = 'p1';
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

  describe('trump picker', () => {
    function trumpSelectMatch(bid: Bid): MatchState {
      const hand = (playerId: string, team: Teams, handBid: Bid) => ({ playerId, team, dominoes: [], bid: handBid });
      return baseMatch(
        {},
        {
          bid,
          biddingPlayerId: 'p1',
          currentPlayerId: 'p1',
          hands: [
            { ...hand('p1', Teams.TeamA, bid), dominoes: [createDomino(1, 2), createDomino(3, 4)] },
            hand('p2', Teams.TeamB, Bid.Pass),
            hand('p3', Teams.TeamA, Bid.Pass),
            hand('p4', Teams.TeamB, Bid.Pass),
          ],
        }
      );
    }

    it('hides Follow Me and Low under a one-mark bid', () => {
      useMatchSocketMock.mockReturnValue({ match: trumpSelectMatch(Bid.FortyOne), connected: true });
      renderMatch();

      const picker = screen.getByRole('region', { name: /select trump/i });
      expect(within(picker).getByRole('button', { name: /sixes/i })).not.toBeNull();
      expect(within(picker).queryByRole('button', { name: /follow me/i })).toBeNull();
      expect(within(picker).queryByRole('button', { name: /^low$/i })).toBeNull();
    });

    it('offers Follow Me and Low at 42 or more', () => {
      useMatchSocketMock.mockReturnValue({ match: trumpSelectMatch(Bid.FortyTwo), connected: true });
      renderMatch();

      const picker = screen.getByRole('region', { name: /select trump/i });
      expect(within(picker).getByRole('button', { name: /follow me/i })).not.toBeNull();
      expect(within(picker).getByRole('button', { name: /^low$/i })).not.toBeNull();
    });

    it('asks how doubles play after picking Low, then names that Low variant', async () => {
      setTrumpMock.mockResolvedValue({} as MatchState);
      useMatchSocketMock.mockReturnValue({ match: trumpSelectMatch(Bid.FortyTwo), connected: true });
      renderMatch();

      fireEvent.click(screen.getByRole('button', { name: /^low$/i }));
      expect(setTrumpMock).not.toHaveBeenCalled();

      const picker = screen.getByRole('region', { name: /select trump/i });
      expect(within(picker).getByRole('button', { name: /^high/i })).not.toBeNull();
      expect(within(picker).getByRole('button', { name: /^low\s*each double/i })).not.toBeNull();
      fireEvent.click(within(picker).getByRole('button', { name: /suit of their own/i }));

      await waitFor(() => expect(setTrumpMock).toHaveBeenCalledWith('match-1', Suit.LowDoublesOwnSuit));
    });

    it('goes back from the doubles step to the full trump list', () => {
      useMatchSocketMock.mockReturnValue({ match: trumpSelectMatch(Bid.FortyTwo), connected: true });
      renderMatch();

      fireEvent.click(screen.getByRole('button', { name: /^low$/i }));
      fireEvent.click(screen.getByRole('button', { name: /back/i }));

      expect(screen.getByRole('button', { name: /sixes/i })).not.toBeNull();
    });
  });

  describe('a Low hand', () => {
    function lowMatch(trump: Suit): MatchState {
      const hand = (playerId: string, team: Teams, handBid: Bid) => ({
        playerId,
        team,
        dominoes: [createDomino(1, 2), createDomino(3, 4)],
        bid: handBid,
      });
      return baseMatch(
        {},
        {
          bid: Bid.FortyTwo,
          biddingPlayerId: 'p1',
          trump,
          currentPlayerId: 'p1',
          hands: [
            hand('p1', Teams.TeamA, Bid.FortyTwo),
            hand('p2', Teams.TeamB, Bid.Pass),
            hand('p3', Teams.TeamA, Bid.Pass),
            hand('p4', Teams.TeamB, Bid.Pass),
          ],
        }
      );
    }

    it("tells the bidder's partner they sit the hand out", () => {
      currentUserId.value = 'p3';
      useMatchSocketMock.mockReturnValue({ match: lowMatch(Suit.Low), connected: true });
      renderMatch();

      expect(screen.getByText(/sit this hand out/i)).not.toBeNull();
    });

    it('does not tell the opponents they sit out', () => {
      currentUserId.value = 'p2';
      useMatchSocketMock.mockReturnValue({ match: lowMatch(Suit.Low), connected: true });
      renderMatch();

      expect(screen.queryByText(/sit this hand out/i)).toBeNull();
    });

    it('shows the doubles rule next to the trump on the scoreboard', () => {
      useMatchSocketMock.mockReturnValue({ match: lowMatch(Suit.LowDoublesOwnSuit), connected: true });
      renderMatch();

      const scoreboard = screen.getByRole('banner', { name: /scores/i });
      expect(within(scoreboard).getByText(/suit of their own/i)).not.toBeNull();
    });
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

  // Regression test: after MY OWN play mutation resolves successfully, there's a real gap before
  // the WebSocket broadcast confirming the new turn actually arrives - `useMatchSocket` only ever
  // updates `match` from a broadcast, never from the mutation's own REST response (client.ts's
  // playDomino DOES return the fresh MatchState, but Match.tsx never reads `playMutation.data`).
  // Without accounting for that gap, `canPlay` briefly reads true again the instant
  // `playMutation.isPending` flips back to false but the (stale) `match` still shows ME as
  // `currentPlayerId` - letting a second play/preselect attempt fire immediately and get rejected
  // server-side with "It's not your turn!".
  it("keeps a player's hand non-clickable after their own play resolves, even before the match broadcast confirms the turn moved on", async () => {
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
    // Deliberately never updated after the play below - simulates the broadcast not having
    // arrived yet, with `match` still showing the pre-play state (currentPlayerId still 'p1').
    useMatchSocketMock.mockReturnValue({ match, connected: true });

    renderMatch();
    const tiles = screen.getAllByTestId('domino');

    fireEvent.click(tiles[0]);
    await waitFor(() => expect(playDominoMock).toHaveBeenCalled());

    // The mutation has resolved, but `match` (from the still-unmoved mock above) hasn't - the
    // remaining tile must NOT be clickable/playable again yet.
    await waitFor(() => {
      expect(screen.getAllByTestId('domino')[0].classList.contains('clickable')).toBe(false);
    });
  });

  // Regression test: `awaitingTurnAdvance`'s clearing condition used to be
  // `holdGame?.currentPlayerId !== myPlayerId` - sound for normal turn rotation, but false
  // whenever the mover ALSO wins the trick they just completed: the engine then sets
  // `currentPlayerId` right back to that same player as leader of the next trick
  // (matchEngine.ts's `playDomino`: `currentPlayerId = currentTrick.playerId` on a full trick),
  // so `currentPlayerId` never actually changes across the broadcast. That stuck
  // `awaitingTurnAdvance` at `true` forever, permanently disabling `canPlay` until a full page
  // refresh reset the component's state from scratch.
  it("lets a player who wins a trick they completed play again once the broadcast confirms it, even though currentPlayerId never changes", async () => {
    playDominoMock.mockResolvedValue({} as MatchState);
    const winningDomino: Domino = createDomino(6, 6); // highest trump - guaranteed trick winner.
    const remainingDomino: Domino = createDomino(3, 4);
    const gameOverrides = { bid: Bid.Thirty, biddingPlayerId: 'p1', trump: Suit.Sixes };

    // p1 is last to act in this trick and about to win it with the domino they're playing.
    const beforePlay = baseMatch(
      {},
      {
        ...gameOverrides,
        currentPlayerId: 'p1',
        hands: [
          { playerId: 'p1', team: Teams.TeamA, dominoes: [winningDomino, remainingDomino], bid: Bid.Thirty },
          { playerId: 'p2', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
          { playerId: 'p3', team: Teams.TeamA, dominoes: [], bid: Bid.Pass },
          { playerId: 'p4', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
        ],
        currentTrick: {
          playerId: 'p2',
          team: Teams.TeamB,
          suit: Suit.Sixes,
          dominoes: [createDomino(6, 1), createDomino(6, 2), createDomino(6, 3), null],
        },
        tricks: [],
      }
    );

    // After the broadcast: the played domino is gone from p1's hand, the trick is completed and
    // now credited to p1, and - the crux of the bug - p1 is STILL currentPlayerId, as leader of
    // the next trick, not someone else.
    const afterPlay = baseMatch(
      {},
      {
        ...gameOverrides,
        currentPlayerId: 'p1',
        hands: [
          { playerId: 'p1', team: Teams.TeamA, dominoes: [remainingDomino], bid: Bid.Thirty },
          { playerId: 'p2', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
          { playerId: 'p3', team: Teams.TeamA, dominoes: [], bid: Bid.Pass },
          { playerId: 'p4', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
        ],
        currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
        tricks: [
          {
            playerId: 'p1',
            team: Teams.TeamA,
            suit: Suit.Sixes,
            dominoes: [createDomino(6, 1), createDomino(6, 2), createDomino(6, 3), winningDomino],
          },
        ],
      }
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const ui = (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Match />
        </MemoryRouter>
      </QueryClientProvider>
    );
    useMatchSocketMock.mockReturnValue({ match: beforePlay, connected: true });
    const { rerender } = render(ui);

    const tilesBefore = within(screen.getByTestId('hand')).getAllByTestId('domino');
    expect(tilesBefore).toHaveLength(2);
    fireEvent.click(tilesBefore[0]); // (6,6), the winning domino - listed first in the hand.
    await waitFor(() => expect(playDominoMock).toHaveBeenCalledWith('match-1', { top: 6, bottom: 6 }));

    useMatchSocketMock.mockReturnValue({ match: afterPlay, connected: true });
    act(() =>
      rerender(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <Match />
          </MemoryRouter>
        </QueryClientProvider>
      )
    );

    // p1 leads the next trick - the one remaining domino must be playable again, not stuck
    // disabled because `currentPlayerId` (still 'p1') never satisfied the old "changed away from
    // me" check.
    await waitFor(() => {
      const tilesAfter = within(screen.getByTestId('hand')).getAllByTestId('domino');
      expect(tilesAfter).toHaveLength(1);
      expect(tilesAfter[0].classList.contains('clickable')).toBe(true);
    });
  });

  // Regression test: a player who has already played into the CURRENT (still in-progress) trick
  // can never play again until the NEXT trick - so any preselection they make in the meantime is
  // unambiguously for that next, not-yet-started trick. Validating it against the current trick's
  // (already-decided) suit is simply the wrong question to ask.
  it('lets a player preselect for the next trick without being bound by the trick they already played into', () => {
    const match = baseMatch(
      {},
      {
        bid: Bid.Thirty,
        biddingPlayerId: 'p1',
        trump: Suit.Sixes,
        currentPlayerId: 'p2', // not my turn - the trick I led is still awaiting p2/p3/p4.
        tricks: [], // this is still the FIRST trick of the hand - 0 completed so far.
        hands: [
          // p1's hand is already short of the fixture's dominoes.length - down to 2, signalling
          // (relative to a full 7-domino hand and 0 completed tricks) that p1 already played into
          // the current trick. (6,6) is trump/suit-Sixes; (4,0) is not - if isValidPlay wrongly
          // applied the current trick's suit (Sixes, since p1 led with a six), it would refuse to
          // preselect (4,0) since p1 "still holds" a Sixes-suit domino.
          { playerId: 'p1', team: Teams.TeamA, dominoes: [createDomino(4, 0), createDomino(6, 6)], bid: Bid.Thirty },
          { playerId: 'p2', team: Teams.TeamB, dominoes: [createDomino(1, 1)], bid: Bid.Pass },
          { playerId: 'p3', team: Teams.TeamA, dominoes: [], bid: Bid.Pass },
          { playerId: 'p4', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
        ],
        currentTrick: { playerId: 'p1', team: Teams.TeamA, suit: Suit.Sixes, dominoes: [createDomino(6, 5), null, null, null] },
      }
    );
    useMatchSocketMock.mockReturnValue({ match, connected: true });
    renderMatch();
    const handTiles = within(screen.getByTestId('hand')).getAllByTestId('domino');

    fireEvent.doubleClick(handTiles[0]); // (4,0)

    expect(handTiles[0].classList.contains('preselected')).toBe(true);
  });

  it('calls bid with the right Bid value when a bid button is clicked', async () => {
    bidMock.mockResolvedValue({} as MatchState);
    const match = baseMatch();
    useMatchSocketMock.mockReturnValue({ match, connected: true });

    renderMatch();

    fireEvent.click(screen.getByRole('button', { name: /^30$/ }));

    await waitFor(() => expect(bidMock).toHaveBeenCalledWith('match-1', Bid.Thirty));
  });

  it('surfaces a ValidationError-shaped API error as a toast', async () => {
    const error = new Error('You must follow suit!: If you have a Six, you must play it');
    playDominoMock.mockRejectedValue(error);
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

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(toastErrorMock.mock.calls[0][0]).toBe(error);
    expect(screen.queryByRole('alert')).toBeNull();
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

    it('lets players keep playing a decided hand alongside the Ready Up option', () => {
      const base = finishedHandMatch();
      const decided = {
        ...base,
        currentGame: {
          ...base.currentGame,
          currentPlayerId: 'p1',
          hands: base.currentGame.hands.map((h) =>
            h.playerId === 'p1' ? { ...h, dominoes: [createDomino(1, 2)] } : h
          ),
        },
      };
      useMatchSocketMock.mockReturnValue({ match: decided, connected: true });
      renderMatch();

      expect(screen.getByRole('region', { name: /hand over/i })).not.toBeNull();
      expect(screen.getByRole('button', { name: /ready up/i })).not.toBeNull();
      const playable = screen.getAllByTestId('domino').filter((tile) => tile.classList.contains('clickable'));
      expect(playable).toHaveLength(1);
    });

    it("shows each player's ready/not-ready status on their seat", () => {
      const finished = finishedHandMatch();
      useMatchSocketMock.mockReturnValue({ match: finished, connected: true });

      renderMatch();

      const statuses = screen.getAllByTestId('ready-status');
      expect(statuses).toHaveLength(4);
      const statusIn = (seat: HTMLElement) => seat.querySelector('[data-testid="ready-status"]')?.textContent;
      const p2Seat = screen.getAllByTestId('remote-player').find((el) => el.textContent?.includes('p2'))!;
      expect(statusIn(p2Seat)).toBe('Ready');
      // p1 is the viewer, seated at the bottom.
      expect(statusIn(screen.getByTestId('my-seat'))).toBe('Not ready');
    });
  });

  describe('Table markers', () => {
    function playingMatch(): MatchState {
      return baseMatch(
        {},
        {
          firstActionBy: 'p1', // p1 opened the bidding, so p4 (seated just before) dealt.
          bid: Bid.ThirtyFour,
          biddingPlayerId: 'p2',
          trump: Suit.Fives,
          currentPlayerId: 'p3',
          hands: [
            { playerId: 'p1', team: Teams.TeamA, dominoes: [createDomino(1, 2)], bid: Bid.Thirty },
            { playerId: 'p2', team: Teams.TeamB, dominoes: [createDomino(0, 0)], bid: Bid.ThirtyFour },
            { playerId: 'p3', team: Teams.TeamA, dominoes: [createDomino(0, 1), createDomino(0, 2)], bid: Bid.Pass },
            { playerId: 'p4', team: Teams.TeamB, dominoes: [createDomino(0, 3)], bid: Bid.Pass },
          ],
          // p2 won the bid, so p2 leads the first trick and has already played.
          currentTrick: { playerId: 'p2', team: Teams.TeamB, suit: Suit.Fives, dominoes: [createDomino(5, 5), null, null, null] },
        }
      );
    }

    function seatOf(name: string): HTMLElement {
      return screen.getAllByTestId('remote-player').find((el) => el.querySelector('.seat-name')?.textContent === name)!;
    }

    it("labels seats with players' display names, keeping the raw id for anyone without one", async () => {
      searchUsersMock.mockResolvedValue([
        { user_id: 'p2', displayName: 'Bob' },
        { user_id: 'p3', displayName: 'Cara' },
      ]);
      useMatchSocketMock.mockReturnValue({ match: playingMatch(), connected: true });
      renderMatch();

      await waitFor(() => expect(seatOf('Bob')).toBeDefined());
      expect(seatOf('Cara')).toBeDefined();
      // p4 has no Auth0 record (e.g. a bot), so it keeps its id.
      expect(seatOf('p4')).toBeDefined();
      // The bid is credited by name too (p2 won it).
      expect(screen.getByText('Bob', { selector: '.contract-by' })).not.toBeNull();
      expect(searchUsersMock).toHaveBeenCalledWith(['p1', 'p2', 'p3', 'p4']);
    });

    it('marks the dealer', () => {
      useMatchSocketMock.mockReturnValue({ match: playingMatch(), connected: true });
      renderMatch();

      expect(seatOf('p4').querySelector('.marker-dealer')).not.toBeNull();
      expect(seatOf('p2').querySelector('.marker-dealer')).toBeNull();
    });

    it("tags the domino that led the trick, seated in front of the player who played it", () => {
      useMatchSocketMock.mockReturnValue({ match: playingMatch(), connected: true });
      const { container } = renderMatch();

      // p2 led, and sits to p1's left (next clockwise).
      const leftSlot = container.querySelector('.trick-slot-left')!;
      expect(leftSlot.querySelector('[data-testid="domino"]')).not.toBeNull();
      expect(leftSlot.querySelector('.trick-lead-tag')).not.toBeNull();
      expect(container.querySelectorAll('.trick-lead-tag')).toHaveLength(1);
    });

    it('marks who is about to lead before the first domino of a trick is down', () => {
      const match = playingMatch();
      match.currentGame.currentPlayerId = 'p2';
      match.currentGame.currentTrick = { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] };
      useMatchSocketMock.mockReturnValue({ match, connected: true });
      renderMatch();

      expect(seatOf('p2').querySelector('.marker-lead')).not.toBeNull();
      expect(seatOf('p3').querySelector('.marker-lead')).toBeNull();
    });

    it('shows the winning bid and trump, credited to the bidding team', () => {
      useMatchSocketMock.mockReturnValue({ match: playingMatch(), connected: true });
      const { container } = renderMatch();

      const contract = container.querySelector('.contract-bid')!;
      expect(contract.classList.contains('contract-them')).toBe(true);
      expect(contract.textContent).toContain('34');
      expect(contract.textContent).toContain('p2');
      expect(seatOf('p2').querySelector('.marker-bid-high')?.textContent).toContain('34');
      // Once trump is named, the other players' bids come off their plates.
      expect(seatOf('p4').querySelector('.marker-bid')).toBeNull();
      expect(screen.getByText('Fives')).not.toBeNull();
    });

    it("draws one face-down tile for each domino another player still holds", () => {
      useMatchSocketMock.mockReturnValue({ match: playingMatch(), connected: true });
      renderMatch();

      expect(seatOf('p3').querySelectorAll('.tile-back')).toHaveLength(2);
      expect(seatOf('p4').querySelectorAll('.tile-back')).toHaveLength(1);
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

  // Regression test for the scoped re-review's finding: `isTableReady` gated on
  // `game.hands[0].dominoes.length > 0` - `hands[0]` is always the match creator's (first-dealt
  // player's) hand. Within the final (7th) trick, players play one at a time in turn order - so
  // whichever player happens to act FIRST in that trick empties their hand before the other 3
  // (who still have 1 domino each, not yet played). If that first-to-act player is the creator,
  // `hands[0].dominoes.length` hits 0 mid-trick, `isTableReady` (and everything gated on it) flips
  // false for EVERYONE, and the match deadlocks permanently - even though 3 players still have a
  // domino left to play and the hand isn't decided (no `gameWinningTeam` yet).
  it("does not deadlock the playing phase when the first-dealt player's hand empties mid-final-trick", async () => {
    playDominoMock.mockResolvedValue({} as MatchState);
    currentUserId.value = 'p2'; // play as someone whose hand still has a domino left.
    const sixCompletedTricksToTeamA = Array.from({ length: 6 }, () => ({
      playerId: 'p1',
      team: Teams.TeamA,
      suit: Suit.Sixes,
      dominoes: [createDomino(0, 0), createDomino(0, 0), createDomino(0, 0), createDomino(0, 0)],
    })); // trickValue = 0 pips + 1 base = 1 each -> 6 total for TeamA, well under the Bid.Thirty
    // (30) threshold, and TeamB never appears in teamPoints - `gameWinningTeam` stays null, so
    // this is genuinely mid-hand, not a finished game that should show Ready Up instead.
    const match = baseMatch(
      {},
      {
        bid: Bid.Thirty,
        biddingPlayerId: 'p1',
        trump: Suit.Sixes,
        currentPlayerId: 'p2', // p1 already played their last domino this trick; p2 is next.
        hands: [
          { playerId: 'p1', team: Teams.TeamA, dominoes: [], bid: Bid.Thirty }, // hands[0] - empty.
          { playerId: 'p2', team: Teams.TeamB, dominoes: [createDomino(6, 6)], bid: Bid.Pass },
          { playerId: 'p3', team: Teams.TeamA, dominoes: [createDomino(5, 5)], bid: Bid.Pass },
          { playerId: 'p4', team: Teams.TeamB, dominoes: [createDomino(4, 4)], bid: Bid.Pass },
        ],
        tricks: sixCompletedTricksToTeamA,
        // The final trick, in progress: p1 has already played, p2/p3/p4 haven't.
        currentTrick: {
          playerId: 'p1',
          team: Teams.TeamA,
          suit: Suit.Sixes,
          dominoes: [createDomino(6, 1), null, null, null],
        },
      }
    );
    useMatchSocketMock.mockReturnValue({ match, connected: true });

    renderMatch();

    // p2 is active and still holds a domino - the playing phase must still be live for them.
    // Scoped to the "hand" region since the in-progress trick also renders a `domino` tile.
    const tile = within(screen.getByTestId('hand')).getByTestId('domino');
    expect(tile.classList.contains('clickable')).toBe(true);

    fireEvent.click(tile);
    await waitFor(() => expect(playDominoMock).toHaveBeenCalledWith('match-1', { top: 6, bottom: 6 }));
  });

  // Match.tsx wires Hand's `isValidPlay` to the same `@fortytwo/rules` `assertValidDomino`
  // follow-suit check the server enforces, so a player can only preselect (double-click before
  // their turn) a domino that would actually be legal to play once the trick's suit is set.
  describe('Preselecting a domino before your turn (Hand isValidPlay wiring)', () => {
    function followSuitMatch(): MatchState {
      return baseMatch(
        {},
        {
          bid: Bid.Thirty,
          biddingPlayerId: 'p1',
          trump: Suit.Sixes,
          currentPlayerId: 'p2', // NOT p1's turn - p1 can only preselect, not play directly.
          hands: [
            // (4,0) is suit Fours (a legal follow); (2,3) is neither Fours nor trump (illegal
            // while a Fours-suit domino is still in hand) - see domino.ts's isOfSuit. Padded out to
            // a realistic full 7-domino hand (with 0 completed tricks) so `haveIPlayedInCurrentTrick`
            // (Match.tsx) correctly reads p1 as NOT having played into the current trick yet.
            {
              playerId: 'p1',
              team: Teams.TeamA,
              dominoes: [
                createDomino(4, 0),
                createDomino(2, 3),
                createDomino(0, 0),
                createDomino(0, 1),
                createDomino(0, 2),
                createDomino(1, 2),
                createDomino(2, 2),
              ],
              bid: Bid.Thirty,
            },
            { playerId: 'p2', team: Teams.TeamB, dominoes: [createDomino(1, 1)], bid: Bid.Pass },
            { playerId: 'p3', team: Teams.TeamA, dominoes: [], bid: Bid.Pass },
            { playerId: 'p4', team: Teams.TeamB, dominoes: [], bid: Bid.Pass },
          ],
          currentTrick: { playerId: 'p2', team: Teams.TeamB, suit: Suit.Fours, dominoes: [createDomino(4, 1), null, null, null] },
        }
      );
    }

    it('preselects a domino that would legally follow suit', () => {
      useMatchSocketMock.mockReturnValue({ match: followSuitMatch(), connected: true });
      renderMatch();
      const handTiles = within(screen.getByTestId('hand')).getAllByTestId('domino');

      fireEvent.doubleClick(handTiles[0]); // (4,0)

      expect(handTiles[0].classList.contains('preselected')).toBe(true);
    });

    it('refuses to preselect a domino that would break the follow-suit rule', () => {
      useMatchSocketMock.mockReturnValue({ match: followSuitMatch(), connected: true });
      renderMatch();
      const handTiles = within(screen.getByTestId('hand')).getAllByTestId('domino');

      fireEvent.doubleClick(handTiles[1]); // (2,3)

      expect(handTiles[1].classList.contains('preselected')).toBe(false);
    });
  });

  // Regression coverage for the "trick vanishes instantly" complaint: a just-completed trick
  // should keep showing center-board for a beat, and its dominoes/points shouldn't jump into the
  // winning team's side pile until that hold expires.
  describe('Trick hold + side history', () => {
    function renderLiveMatch() {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      const ui = (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <Match />
          </MemoryRouter>
        </QueryClientProvider>
      );
      const utils = render(ui);
      return { ...utils, rerenderUi: () => utils.rerender(ui) };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    // Regression test: the completing broadcast moves the trick into `tricks` and empties
    // `currentTrick` in one step. If the held trick is only picked up in an effect, the render in
    // between shows an empty trick, unmounting every tile - and remounting them replays each
    // tile's fly-in animation. The tiles already on the table must survive as the same nodes.
    it('keeps the already-played tiles mounted when the last domino completes the trick', () => {
      const hands = [
        { playerId: 'p1', team: Teams.TeamA, dominoes: [createDomino(1, 2)], bid: Bid.Thirty },
        { playerId: 'p2', team: Teams.TeamB, dominoes: [createDomino(3, 4)], bid: Bid.Pass },
        { playerId: 'p3', team: Teams.TeamA, dominoes: [createDomino(5, 6)], bid: Bid.Pass },
        { playerId: 'p4', team: Teams.TeamB, dominoes: [createDomino(0, 6)], bid: Bid.Pass },
      ];
      const gameOverrides = { bid: Bid.Thirty, biddingPlayerId: 'p1', trump: Suit.Sixes, hands };
      const played = [createDomino(0, 0), createDomino(1, 1), createDomino(2, 2)];

      useMatchSocketMock.mockReturnValue({
        match: baseMatch(
          {},
          {
            ...gameOverrides,
            currentPlayerId: 'p4',
            currentTrick: { playerId: 'p1', team: Teams.TeamA, suit: Suit.Sixes, dominoes: [...played, null] },
          }
        ),
        connected: true,
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      // A fresh element on each render - re-rendering the identical element object would let
      // React skip the update entirely.
      const ui = () => (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <Match />
          </MemoryRouter>
        </QueryClientProvider>
      );
      const { rerender } = render(ui());
      const tilesBefore = within(screen.getByLabelText(/current trick/i)).getAllByTestId('domino');
      expect(tilesBefore).toHaveLength(3);

      useMatchSocketMock.mockReturnValue({
        match: baseMatch(
          {},
          {
            ...gameOverrides,
            currentPlayerId: 'p1',
            tricks: [{ playerId: 'p1', team: Teams.TeamA, suit: Suit.Sixes, dominoes: [...played, createDomino(3, 3)] }],
          }
        ),
        connected: true,
      });
      act(() => rerender(ui()));

      const tilesAfter = within(screen.getByLabelText(/current trick/i)).getAllByTestId('domino');
      expect(tilesAfter).toHaveLength(4);
      for (const tile of tilesBefore) {
        expect(tile.isConnected).toBe(true);
      }
    });

    it('holds a just-completed trick center-board, then reveals it in the winning side pile after the hold', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      // Distinct dominoes (not 4x the same one) - React keys each rendered tile by `domino.id`,
      // and duplicate ids across a trick's 4 slots (unrealistic for a real deal, where every
      // domino is unique) confuse reconciliation across the held -> revealed re-render.
      const completedTrick: Trick = {
        playerId: 'p1',
        team: Teams.TeamA, // p1's team - "mine" from p1's point of view.
        suit: Suit.Sixes,
        dominoes: [createDomino(0, 0), createDomino(1, 1), createDomino(2, 2), createDomino(3, 3)],
      };
      const gameOverrides = { bid: Bid.Thirty, biddingPlayerId: 'p1', trump: Suit.Sixes, currentPlayerId: 'p1' };

      useMatchSocketMock.mockReturnValue({
        match: baseMatch({}, { ...gameOverrides, tricks: [] }),
        connected: true,
      });
      const { rerenderUi, container } = renderLiveMatch();

      useMatchSocketMock.mockReturnValue({
        match: baseMatch({}, { ...gameOverrides, tricks: [completedTrick] }),
        connected: true,
      });
      act(() => rerenderUi());

      // Still held center-board: all 4 dominoes show in the current-trick area...
      await waitFor(() => {
        expect(within(screen.getByLabelText(/current trick/i)).getAllByTestId('domino')).toHaveLength(4);
      });
      // ...and haven't moved to the side pile / point total yet.
      expect(container.querySelectorAll('.player-team-tricks .trick-history-row')).toHaveLength(0);
      expect(container.querySelector('.player-team-tricks .badge')?.textContent).toBe('0');

      // Near the end of the hold, the trick sweeps off toward the winners' (our) pile.
      await act(() => vi.advanceTimersByTimeAsync(1100));
      expect(screen.getByLabelText(/current trick/i).classList.contains('sweep-us')).toBe(true);

      await act(() => vi.advanceTimersByTimeAsync(400));

      // Hold expired: the center trick area is empty again...
      await waitFor(() => {
        expect(within(screen.getByLabelText(/current trick/i)).queryAllByTestId('domino')).toHaveLength(0);
      });
      // ...and the completed trick (worth trickValue 0+0+0+0+1=1) is now in TeamA's side pile.
      expect(container.querySelectorAll('.player-team-tricks .trick-history-row')).toHaveLength(1);
      expect(container.querySelector('.player-team-tricks .badge')?.textContent).toBe('1');
    });

    it('trims each side to its last 2 tricks once the bid is big enough (matching the old Blazor shouldStack rule)', () => {
      const tricksFor = (team: Teams, count: number): Trick[] =>
        Array.from({ length: count }, () => ({
          playerId: 'p1',
          team,
          suit: Suit.Sixes,
          dominoes: [createDomino(0, 0), createDomino(0, 0), createDomino(0, 0), createDomino(0, 0)],
        }));

      const match = baseMatch(
        {},
        {
          bid: Bid.EightyFour, // > FortyTwo (42), not Plunge -> stacking kicks in.
          biddingPlayerId: 'p1',
          trump: Suit.Sixes,
          tricks: [...tricksFor(Teams.TeamA, 3), ...tricksFor(Teams.TeamB, 3)],
        }
      );
      useMatchSocketMock.mockReturnValue({ match, connected: true });

      const { container } = render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter>
            <Match />
          </MemoryRouter>
        </QueryClientProvider>
      );

      expect(container.querySelectorAll('.player-team-tricks .trick-history-row')).toHaveLength(2);
      expect(container.querySelectorAll('.opponent-tricks .trick-history-row')).toHaveLength(2);
    });
  });
});
