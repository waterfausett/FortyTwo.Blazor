// Tests the Lobby page's tabbed match list (Active / Game History, defaulting to Active) plus
// the New match chooser and manual refresh button. `apiClient` (client.ts) is
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

const { listMatchesMock, createMatchMock, playMock, playBotsMock, getConfigMock, getProfileMock, patchProfileMock, getPeopleMock, searchPeopleMock, addFriendMock, removeFriendMock, getInvitesMock, dismissInviteMock, invitePlayersMock, mockNavigate } = vi.hoisted(() => ({
  listMatchesMock: vi.fn(),
  getProfileMock: vi.fn(),
  patchProfileMock: vi.fn(),
  createMatchMock: vi.fn(),
  playMock: vi.fn(),
  playBotsMock: vi.fn(),
  getConfigMock: vi.fn(),
  getPeopleMock: vi.fn(),
  searchPeopleMock: vi.fn(),
  addFriendMock: vi.fn(),
  removeFriendMock: vi.fn(),
  getInvitesMock: vi.fn(),
  dismissInviteMock: vi.fn(),
  invitePlayersMock: vi.fn(async (_m: string, ids: string[]) => ({ invited: ids })),
  mockNavigate: vi.fn(),
}));

vi.mock('../api/client', () => ({
  apiClient: () => ({
    listMatches: listMatchesMock,
    createMatch: createMatchMock,
    play: playMock,
    playBots: playBotsMock,
    getConfig: getConfigMock,
    getProfile: getProfileMock,
    patchProfile: patchProfileMock,
    getPeople: getPeopleMock,
    searchPeople: searchPeopleMock,
    addFriend: addFriendMock,
    removeFriend: removeFriendMock,
    getInvites: getInvitesMock,
    dismissInvite: dismissInviteMock,
    invitePlayers: invitePlayersMock,
  }),
}));

vi.mock('../api/presence', () => ({ useOnline: () => 3 }));

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
    mode: 'custom',
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
const COMPLETED_FIXTURE: MatchSummary[] = [
  {
    id: 'completed-1',
    mode: 'custom',
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
const COMPLETED_ROW = 'Alice & Cara vs Bob & Dan';

const page = (matches: MatchSummary[], nextCursor: string | null = null): MatchPage => ({ matches, nextCursor });

function mockLists() {
  listMatchesMock.mockImplementation((filter: 'Active' | 'Completed') => {
    switch (filter) {
      case 'Active':
        return Promise.resolve(page(ACTIVE_FIXTURE));
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
    getConfigMock.mockResolvedValue({ bots: true });
    getProfileMock.mockResolvedValue({ user_id: 'me', displayName: 'Me', seenHowToPlay: true });
    getInvitesMock.mockResolvedValue([]);
    getPeopleMock.mockResolvedValue([]);
  });

  afterEach(() => {
    // vitest.config.ts doesn't set `test.globals: true`, so @testing-library/react's
    // auto-cleanup (which only self-registers when it finds a *global* `afterEach`) never runs -
    // without this, each test's rendered tree stays mounted into the next, so e.g. two "Create
    // Match" buttons end up in the DOM by the second test.
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the People tab without fetching matches for it', async () => {
    getPeopleMock.mockResolvedValue([{ user_id: 'bo', displayName: 'Bo', isFriend: false, lastPlayedOn: '2026-01-01T00:00:00.000Z', games: 1 }]);
    renderLobby();
    fireEvent.click(await screen.findByRole('tab', { name: 'People' }));
    expect(await screen.findByText('Bo')).toBeTruthy();
    expect(listMatchesMock).not.toHaveBeenCalledWith('People', expect.anything());
  });

  it('invites a person from the People tab to one of your open tables', async () => {
    getPeopleMock.mockResolvedValue([{ user_id: 'bo', displayName: 'Bo', isFriend: true, lastPlayedOn: null, games: 0 }]);
    listMatchesMock.mockResolvedValue({
      matches: [{ id: 'm1', status: 'active', playerCount: 2, updatedOn: '2026-01-01T00:00:00.000Z', teams: [['Me'], ['Ann']], seats: ['Me', null, 'Ann', null], mode: 'custom' }],
      nextCursor: null,
    });
    renderLobby();
    fireEvent.click(await screen.findByRole('tab', { name: 'People' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Invite Bo to a table' }));
    expect(await screen.findByRole('heading', { name: 'Invite Bo' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Invite Bo to Me vs Ann' }));
    await waitFor(() => expect(invitePlayersMock).toHaveBeenCalledWith('m1', ['bo']));
  });

  it('opens People on friends only', async () => {
    renderLobby();
    fireEvent.click(await screen.findByRole('tab', { name: 'People' }));
    expect(await screen.findByRole('button', { name: 'Recent players' })).toBeTruthy();
    expect(getPeopleMock).toHaveBeenCalledWith('friends');
  });

  it('shows invites above the tabs', async () => {
    getInvitesMock.mockResolvedValue([{ matchId: 'm1', from: { user_id: 'ann', displayName: 'Ann' }, createdOn: '2026-01-01T00:00:00.000Z', seatsOpen: 3 }]);
    renderLobby();
    expect(await screen.findByText('Ann invited you')).toBeTruthy();
  });

  it('defaults to the Active tab and fetches only that list', async () => {
    renderLobby();

    await screen.findByText(ACTIVE_ROW);

    expect(screen.getByRole('tab', { name: /active/i }).getAttribute('aria-selected')).toBe('true');
    expect(listMatchesMock).toHaveBeenCalledWith('Active', undefined);
    expect(listMatchesMock).not.toHaveBeenCalledWith('Completed', undefined);
  });

  it('fetches a tab only once it is selected', async () => {
    renderLobby();
    await screen.findByText(ACTIVE_ROW);
    listMatchesMock.mockClear();

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

  it('shows only the Active and History tabs', async () => {
    renderLobby();
    expect(await screen.findByRole('tab', { name: /active/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /history/i })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /find a game/i })).toBeNull();
  });

  it('puts your-turn games first, with a badge', async () => {
    listMatchesMock.mockResolvedValue({
      matches: [
        { ...ACTIVE_FIXTURE[0], id: 'theirs', turn: { kind: 'turn', yours: false, waitingOn: ['Eli'] } },
        { ...ACTIVE_FIXTURE[0], id: 'mine', turn: { kind: 'turn', yours: true, waitingOn: ['Alice'] } },
      ],
      nextCursor: null,
    });
    renderLobby();
    const rows = await screen.findAllByRole('listitem');
    expect(within(rows[0]).getByText('Your turn')).toBeTruthy();
    expect(within(rows[1]).getByText(/Eli's turn/)).toBeTruthy();
  });

  it('starts Async matchmaking from the chooser and opens the match', async () => {
    playMock.mockResolvedValue({ id: 'daily-1' } as MatchState);
    renderLobby();
    fireEvent.click(await screen.findByRole('button', { name: /new match/i }));
    fireEvent.click(screen.getByRole('button', { name: /async/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/match/daily-1'));
    expect(playMock).toHaveBeenCalledWith('daily');
  });

  it('shows how many players are online in the chooser', async () => {
    renderLobby();
    fireEvent.click(await screen.findByRole('button', { name: /new match/i }));
    expect(await screen.findByText('3 online')).toBeTruthy();
  });

  it('creates a custom table for Custom Match', async () => {
    createMatchMock.mockResolvedValue({ id: 'custom-1' } as MatchState);
    renderLobby();
    fireEvent.click(await screen.findByRole('button', { name: /new match/i }));
    fireEvent.click(screen.getByRole('button', { name: /custom match/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/match/custom-1'));
  });

  it('starts a match against bots for Play vs bots', async () => {
    playBotsMock.mockResolvedValue({ id: 'bots-1' } as MatchState);
    renderLobby();
    fireEvent.click(await screen.findByRole('button', { name: /new match/i }));
    fireEvent.click(await screen.findByRole('button', { name: /play vs bots/i }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/match/bots-1'));
  });

  it('shows a failed start in the chooser, and clears it when the chooser opens again', async () => {
    playMock.mockRejectedValue(new Error('Request timed out'));
    renderLobby();
    fireEvent.click(await screen.findByRole('button', { name: /new match/i }));
    fireEvent.click(screen.getByRole('button', { name: /async/i }));
    const dialog = screen.getByRole('dialog');
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Request timed out');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /new match/i }));
    expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull();
  });

  // A player who left the match page (or the creator, before anyone else joined) gets back in
  // through the match's row.
  it('renders each match row as a link to its match page', async () => {
    renderLobby();

    const activeLink = (await screen.findByText(ACTIVE_ROW)).closest('a');
    expect(activeLink).not.toBeNull();
    expect(activeLink?.getAttribute('href')).toBe('/match/active-1');
  });

  it('falls back to the match id for a row with no players listed', async () => {
    listMatchesMock.mockResolvedValue(page([
      {
        id: 'no-players',
        mode: 'custom',
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

describe('Lobby: How to play card', () => {
  const CARD = { name: 'New to Forty-Two' };

  beforeEach(() => {
    mockLists();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('offers the rules to a player who has not seen them', async () => {
    getProfileMock.mockResolvedValue({ user_id: 'me', displayName: 'Me', seenHowToPlay: false });
    renderLobby();

    const card = await screen.findByRole('complementary', CARD);
    expect(within(card).getByRole('link', { name: 'New to 42? Learn how to play' }).getAttribute('href')).toBe('/how-to-play');
  });

  it.each([
    ['has seen the rules', { user_id: 'me', displayName: 'Me', seenHowToPlay: true }],
    ['comes from a worker that does not know the setting', { user_id: 'me', displayName: 'Me' }],
  ])('shows no card when the profile %s', async (_, profile) => {
    getProfileMock.mockResolvedValue(profile);
    renderLobby();

    await screen.findByText(ACTIVE_ROW);
    await waitFor(() => expect(getProfileMock).toHaveBeenCalled());
    expect(screen.queryByRole('complementary', CARD)).toBeNull();
  });

  it('dismisses the card at once and saves that', async () => {
    getProfileMock.mockResolvedValue({ user_id: 'me', displayName: 'Me', seenHowToPlay: false });
    patchProfileMock.mockResolvedValue(undefined);
    renderLobby();

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(screen.queryByRole('complementary', CARD)).toBeNull());
    expect(patchProfileMock).toHaveBeenCalledWith({ seenHowToPlay: true });
  });

  it('brings the card back if the save fails', async () => {
    getProfileMock.mockResolvedValue({ user_id: 'me', displayName: 'Me', seenHowToPlay: false });
    patchProfileMock.mockRejectedValue(new Error('offline'));
    renderLobby();

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(patchProfileMock).toHaveBeenCalled());
    expect(await screen.findByRole('complementary', CARD)).toBeTruthy();
  });
});
