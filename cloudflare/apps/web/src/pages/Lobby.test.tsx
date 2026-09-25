// Tests the Lobby page's three polling match-list sections (Active/Joinable/Completed) plus its
// create/join actions. `apiClient` (client.ts) is mocked at the module level rather than injected
// as a prop - Lobby.tsx calls `apiClient(getToken)` internally per the brief's "Consumes:
// apiClient().listMatches..." framing - so tests control each method's mocked return/behavior
// directly. `@auth0/auth0-react`'s `useAuth0` is likewise mocked rather than wrapped in a real
// `Auth0Provider`, since only a working `getAccessTokenSilently` stub is needed here, not real
// auth behavior. `react-router-dom`'s `useNavigate` is overridden (keeping the rest of the real
// module, including `MemoryRouter`) so the create-match-success redirect can be asserted directly.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchState } from '@fortytwo/rules';
import type { MatchSummary } from '../api/client';
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
  { id: 'active-1', status: 'active', playerCount: 4, updatedOn: '2026-01-01T00:00:00.000Z' },
];
const JOINABLE_FIXTURE: MatchSummary[] = [
  { id: 'joinable-1', status: 'active', playerCount: 2, updatedOn: '2026-01-01T00:00:00.000Z' },
];
const COMPLETED_FIXTURE: MatchSummary[] = [
  { id: 'completed-1', status: 'completed', playerCount: 4, updatedOn: '2026-01-01T00:00:00.000Z' },
];

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

describe('Lobby', () => {
  beforeEach(() => {
    listMatchesMock.mockImplementation((filter: 'Active' | 'Completed' | 'Joinable') => {
      switch (filter) {
        case 'Active':
          return Promise.resolve(ACTIVE_FIXTURE);
        case 'Joinable':
          return Promise.resolve(JOINABLE_FIXTURE);
        case 'Completed':
          return Promise.resolve(COMPLETED_FIXTURE);
      }
    });
  });

  afterEach(() => {
    // vitest.config.ts doesn't set `test.globals: true`, so @testing-library/react's
    // auto-cleanup (which only self-registers when it finds a *global* `afterEach`) never runs -
    // without this, each test's rendered tree stays mounted into the next, so e.g. two "Create
    // Match" buttons end up in the DOM by the second test.
    cleanup();
    vi.clearAllMocks();
  });

  it('renders each section with its fetched matches', async () => {
    renderLobby();

    await screen.findByText('active-1');
    await screen.findByText('joinable-1');
    await screen.findByText('completed-1');

    expect(listMatchesMock).toHaveBeenCalledWith('Active');
    expect(listMatchesMock).toHaveBeenCalledWith('Joinable');
    expect(listMatchesMock).toHaveBeenCalledWith('Completed');
  });

  it('calls createMatch and navigates to the new match on click', async () => {
    createMatchMock.mockResolvedValue({ id: 'new-match-id' } as MatchState);
    renderLobby();

    await screen.findByText('active-1');
    fireEvent.click(screen.getByRole('button', { name: /create match/i }));

    await waitFor(() => expect(createMatchMock).toHaveBeenCalled());
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/match/new-match-id'));
  });

  it('calls joinMatch with the row id when Join is clicked, then navigates to the joined match', async () => {
    joinMatchMock.mockResolvedValue({ id: 'joinable-1' } as MatchState);
    renderLobby();

    const row = (await screen.findByText('joinable-1')).closest('li');
    expect(row).not.toBeNull();
    const joinButton = within(row as HTMLElement).getByRole('button', { name: /join/i });
    fireEvent.click(joinButton);

    await waitFor(() => expect(joinMatchMock).toHaveBeenCalledWith('joinable-1', expect.any(Number)));
    // Regression test for CRITICAL finding #4: joining used to only invalidate the list queries,
    // leaving the player with no way back to the match they just joined except typing the URL.
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/match/joinable-1'));
  });

  // Regression tests for the scoped re-review's CRITICAL 3 follow-up: Lobby used to always join
  // `DEFAULT_JOIN_TEAM` (TeamA) regardless of who was already seated. Since createMatch always
  // seats the creator on TeamA (position First), and the server now genuinely rejects a full team
  // (`assertTeamNotFull`), a fixed TeamA meant the 3rd join into ANY match always failed with
  // "Team is full" - no match could ever reach 4 players through the UI. The fix must pick
  // whichever team still has room, inferred from `MatchSummary.playerCount` (the only team-shaped
  // signal the lobby list exposes) under the assumption that every prior join alternated teams the
  // same way (each match starts with exactly 1 player, always on TeamA).
  describe('join team selection', () => {
    function renderWithJoinable(match: MatchSummary) {
      listMatchesMock.mockImplementation((filter: 'Active' | 'Completed' | 'Joinable') => {
        switch (filter) {
          case 'Active':
            return Promise.resolve(ACTIVE_FIXTURE);
          case 'Joinable':
            return Promise.resolve([match]);
          case 'Completed':
            return Promise.resolve(COMPLETED_FIXTURE);
        }
      });
      joinMatchMock.mockResolvedValue({ id: match.id } as MatchState);
      renderLobby();
    }

    it('requests TeamB when only the creator (1 player, on TeamA) is seated', async () => {
      renderWithJoinable({ id: 'j1', status: 'active', playerCount: 1, updatedOn: '2026-01-01T00:00:00.000Z' });

      fireEvent.click(await screen.findByRole('button', { name: /join/i }));

      await waitFor(() => expect(joinMatchMock).toHaveBeenCalledWith('j1', 2 /* Teams.TeamB */));
    });

    it('requests TeamA when 2 players (1 per team) are seated', async () => {
      renderWithJoinable({ id: 'j2', status: 'active', playerCount: 2, updatedOn: '2026-01-01T00:00:00.000Z' });

      fireEvent.click(await screen.findByRole('button', { name: /join/i }));

      await waitFor(() => expect(joinMatchMock).toHaveBeenCalledWith('j2', 1 /* Teams.TeamA */));
    });

    it('requests TeamB when 3 players (2 on TeamA, 1 on TeamB) are seated', async () => {
      renderWithJoinable({ id: 'j3', status: 'active', playerCount: 3, updatedOn: '2026-01-01T00:00:00.000Z' });

      fireEvent.click(await screen.findByRole('button', { name: /join/i }));

      await waitFor(() => expect(joinMatchMock).toHaveBeenCalledWith('j3', 2 /* Teams.TeamB */));
    });
  });

  // Regression test for CRITICAL finding #4 from the final whole-branch review: the Active/
  // Joinable rows previously showed only id and player count, with no link to `/match/:id`
  // anywhere - a player who left the match page (or the creator, before anyone else joined) had no
  // way back in except manually typing a URL.
  it('renders each match row as a link to its match page', async () => {
    renderLobby();

    const activeLink = (await screen.findByText('active-1')).closest('a');
    expect(activeLink).not.toBeNull();
    expect(activeLink?.getAttribute('href')).toBe('/match/active-1');

    const joinableLink = (await screen.findByText('joinable-1')).closest('a');
    expect(joinableLink?.getAttribute('href')).toBe('/match/joinable-1');
  });
});
