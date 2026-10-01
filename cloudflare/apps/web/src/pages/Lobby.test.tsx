// Tests the Lobby page's tabbed match list (Find a Game / Active / Game History, defaulting to
// Active) plus its create/join actions and manual refresh button. `apiClient` (client.ts) is
// mocked at the module level rather than injected as a prop - Lobby.tsx calls `apiClient(getToken)`
// internally - so tests control each method's mocked return/behavior directly. `@auth0/auth0-react`'s `useAuth0` is likewise
// mocked rather than wrapped in a real `Auth0Provider`, since only a working
// `getAccessTokenSilently` stub is needed here, not real auth behavior. `react-router-dom`'s
// `useNavigate` is overridden (keeping the rest of the real module, including `MemoryRouter`) so
// the create-match-success redirect can be asserted directly.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchState } from '@fortytwo/rules';
import type { MatchPage, MatchSummary } from '../api/client';
import { Lobby } from './Lobby';

const { listMatchesMock, createMatchMock, joinMatchMock, mockNavigate } = vi.hoisted(() => ({
  listMatchesMock: vi.fn(),
  createMatchMock: vi.fn(),
  joinMatchMock: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock('../api/client', () => ({
  apiClient: () => ({
    listMatches: listMatchesMock,
    createMatch: createMatchMock,
    joinMatch: joinMatchMock,
  }),
}));

vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({ getAccessTokenSilently: vi.fn(async () => 'test-token') }),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

const ACTIVE_FIXTURE: MatchSummary[] = [
  {
    id: 'active-1',
    status: 'active',
    playerCount: 4,
    updatedOn: '2026-01-01T00:00:00.000Z',
    teams: [
      ['Alice', 'bot-2'],
      ['bot-1', 'bot-3'],
    ],
    seats: ['Alice', 'bot-1', 'bot-2', 'bot-3'],
  },
];
// Bob created it (seat 0) and Cara sat on his right (seat 3), leaving seats 1 and 2 open.
const JOINABLE_FIXTURE: MatchSummary[] = [
  {
    id: 'joinable-1',
    status: 'active',
    playerCount: 2,
    updatedOn: '2026-01-01T00:00:00.000Z',
    teams: [['Bob'], ['Cara']],
    seats: ['Bob', null, null, 'Cara'],
  },
];
const COMPLETED_FIXTURE: MatchSummary[] = [
  {
    id: 'completed-1',
    status: 'completed',
    playerCount: 4,
    updatedOn: '2026-01-01T00:00:00.000Z',
    teams: [
      ['Alice', 'Cara'],
      ['Bob', 'Dan'],
    ],
    seats: ['Alice', 'Bob', 'Cara', 'Dan'],
  },
];
// Each row is labelled by its matchup, not the match id.
const ACTIVE_ROW = 'Alice & bot-2 vs bot-1 & bot-3';
const JOINABLE_ROW = 'Bob vs Cara';
const COMPLETED_ROW = 'Alice & Cara vs Bob & Dan';

const page = (matches: MatchSummary[], nextCursor: string | null = null): MatchPage => ({ matches, nextCursor });

function mockLists() {
  listMatchesMock.mockImplementation((filter: 'Active' | 'Completed' | 'Joinable') => {
    switch (filter) {
      case 'Active':
        return Promise.resolve(page(ACTIVE_FIXTURE));
      case 'Joinable':
        return Promise.resolve(page(JOINABLE_FIXTURE));
      case 'Completed':
        return Promise.resolve(page(COMPLETED_FIXTURE));
    }
  });
}

function renderLobby() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Lobby />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function switchTab(name: RegExp) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

describe('Lobby', () => {
  beforeEach(() => {
    mockLists();
  });

  afterEach(() => {
    // vitest.config.ts doesn't set `test.globals: true`, so @testing-library/react's
    // auto-cleanup (which only self-registers when it finds a *global* `afterEach`) never runs -
    // without this, each test's rendered tree stays mounted into the next, so e.g. two "Create
    // Match" buttons end up in the DOM by the second test.
    cleanup();
    vi.clearAllMocks();
  });

  it('defaults to the Active tab and fetches only that list', async () => {
    renderLobby();

    await screen.findByText(ACTIVE_ROW);

    expect(screen.getByRole('tab', { name: /active games/i }).getAttribute('aria-selected')).toBe('true');
    expect(listMatchesMock).toHaveBeenCalledWith('Active', undefined);
    expect(listMatchesMock).not.toHaveBeenCalledWith('Joinable', undefined);
    expect(listMatchesMock).not.toHaveBeenCalledWith('Completed', undefined);
  });

  it('fetches a tab only once it is selected', async () => {
    renderLobby();
    await screen.findByText(ACTIVE_ROW);
    listMatchesMock.mockClear();

    switchTab(/find a game/i);
    await screen.findByText(JOINABLE_ROW);
    expect(listMatchesMock).toHaveBeenCalledWith('Joinable', undefined);
    expect(listMatchesMock).not.toHaveBeenCalledWith('Completed', undefined);

    switchTab(/game history/i);
    await screen.findByText(COMPLETED_ROW);
    expect(listMatchesMock).toHaveBeenCalledWith('Completed', undefined);
  });

  it('does not refetch on a timer - only the initial fetch happens without a manual refresh', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderLobby();
      await act(() => vi.waitFor(() => expect(listMatchesMock).toHaveBeenCalledTimes(1)));

      await act(() => vi.advanceTimersByTimeAsync(60_000));

      expect(listMatchesMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refetches the currently selected tab when the refresh button is clicked', async () => {
    renderLobby();
    await screen.findByText(ACTIVE_ROW);
    expect(listMatchesMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(listMatchesMock).toHaveBeenCalledTimes(2));
    expect(listMatchesMock).toHaveBeenLastCalledWith('Active', undefined);
  });

  it('spins the refresh icon only while a refetch is in flight', async () => {
    renderLobby();
    await screen.findByText(ACTIVE_ROW);

    const icon = document.querySelector('.lobby-refresh .oi') as HTMLElement;
    expect(icon.className).not.toMatch(/spinner-reverse/);

    let resolveRefetch!: (result: MatchPage) => void;
    listMatchesMock.mockReturnValueOnce(new Promise((resolve) => (resolveRefetch = resolve)));

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    await waitFor(() => expect(icon.className).toMatch(/spinner-reverse/));

    resolveRefetch(page(ACTIVE_FIXTURE));

    await waitFor(() => expect(icon.className).not.toMatch(/spinner-reverse/));
  });

  it('calls createMatch and navigates to the new match on click', async () => {
    createMatchMock.mockResolvedValue({ id: 'new-match-id' } as MatchState);
    renderLobby();

    await screen.findByText(ACTIVE_ROW);
    fireEvent.click(screen.getByRole('button', { name: /create match/i }));

    await waitFor(() => expect(createMatchMock).toHaveBeenCalled());
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/match/new-match-id'));
  });

  describe('joining', () => {
    async function openSeatPicker() {
      renderLobby();
      switchTab(/find a game/i);
      const row = (await screen.findByText(JOINABLE_ROW)).closest('li') as HTMLElement;
      fireEvent.click(within(row).getByRole('button', { name: /join/i }));
      return within(row).getByRole('group', { name: /pick a seat/i });
    }

    it('opens a seat picker showing who sits where, with a button in each open seat', async () => {
      const picker = await openSeatPicker();

      expect(within(picker).getByText('Bob')).toBeTruthy();
      expect(within(picker).getByText('Cara')).toBeTruthy();
      // Seat 1 is across from Cara, seat 2 across from Bob - each says who you'd partner with.
      const seats = within(picker).getAllByRole('button');
      expect(seats.map((seat) => seat.textContent)).toEqual(['Sit herewith Cara', 'Sit herewith Bob']);
      expect(joinMatchMock).not.toHaveBeenCalled();
    });

    it('joins at the picked seat, then navigates to the joined match', async () => {
      joinMatchMock.mockResolvedValue({ id: 'joinable-1' } as MatchState);
      const picker = await openSeatPicker();

      fireEvent.click(within(picker).getByRole('button', { name: /with bob/i }));

      await waitFor(() => expect(joinMatchMock).toHaveBeenCalledWith('joinable-1', 2));
      // Joining takes the player straight to the match they just joined.
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/match/joinable-1'));
    });

    it('closes the picker on Cancel', async () => {
      await openSeatPicker();

      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

      expect(screen.queryByRole('group', { name: /pick a seat/i })).toBeNull();
    });

    it('shows the error and refreshes the list when the seat was taken first', async () => {
      joinMatchMock.mockRejectedValue(new Error('Seat is taken: Someone is already sitting there'));
      const picker = await openSeatPicker();
      listMatchesMock.mockClear();

      fireEvent.click(within(picker).getByRole('button', { name: /with cara/i }));

      expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Seat is taken: Someone is already sitting there');
      await waitFor(() => expect(listMatchesMock).toHaveBeenCalledWith('Joinable', undefined));
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  // A player who left the match page (or the creator, before anyone else joined) gets back in
  // through the match's row.
  it('renders each match row as a link to its match page', async () => {
    renderLobby();

    const activeLink = (await screen.findByText(ACTIVE_ROW)).closest('a');
    expect(activeLink).not.toBeNull();
    expect(activeLink?.getAttribute('href')).toBe('/match/active-1');

    switchTab(/find a game/i);
    const joinableLink = (await screen.findByText(JOINABLE_ROW)).closest('a');
    expect(joinableLink?.getAttribute('href')).toBe('/match/joinable-1');
  });

  it('falls back to the match id for a row with no players listed', async () => {
    listMatchesMock.mockResolvedValue(page([
      {
        id: 'no-players',
        status: 'active',
        playerCount: 0,
        updatedOn: '2026-01-01T00:00:00.000Z',
        teams: [[], []],
        seats: [null, null, null, null],
      },
    ]));
    renderLobby();

    await screen.findByText('no-players');
  });

  describe('paging', () => {
    const SECOND: MatchSummary = { ...ACTIVE_FIXTURE[0], id: 'active-2', teams: [['Erin'], ['Finn']], seats: ['Erin', 'Finn', null, null] };

    beforeEach(() => {
      listMatchesMock.mockImplementation((_filter: string, cursor?: string) =>
        // Page 2 repeats active-1, as if it was updated (and moved up) between the two loads.
        Promise.resolve(cursor === undefined ? page(ACTIVE_FIXTURE, 'c1') : page([ACTIVE_FIXTURE[0], SECOND]))
      );
    });

    it('appends the next page on Load more, shows a repeated match once, and hides the button at the end', async () => {
      renderLobby();
      await screen.findByText(ACTIVE_ROW);

      fireEvent.click(screen.getByRole('button', { name: /load more/i }));

      await screen.findByText('Erin vs Finn');
      expect(listMatchesMock).toHaveBeenLastCalledWith('Active', 'c1');
      expect(screen.getAllByText(ACTIVE_ROW)).toHaveLength(1);
      expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
    });

    it('shows no Load more when the first page is the last', async () => {
      mockLists();
      renderLobby();
      await screen.findByText(ACTIVE_ROW);
      expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
    });

    it('refreshes only the first page', async () => {
      renderLobby();
      await screen.findByText(ACTIVE_ROW);
      fireEvent.click(screen.getByRole('button', { name: /load more/i }));
      await screen.findByText('Erin vs Finn');
      expect(listMatchesMock).toHaveBeenCalledTimes(2);

      fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

      await waitFor(() => expect(listMatchesMock).toHaveBeenCalledTimes(3));
      expect(listMatchesMock).toHaveBeenLastCalledWith('Active', undefined);
      await waitFor(() => expect(screen.queryByText('Erin vs Finn')).toBeNull());
      expect(screen.getByText(ACTIVE_ROW)).toBeTruthy();
    });
  });
});
