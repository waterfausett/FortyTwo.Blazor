import { fireEvent, render, screen } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PlayerStats as Stats, StatsSummary } from '@fortytwo/api-types';
import { PlayerStats } from '../PlayerStats';

const mockGetStats = jest.fn();
jest.mock('@/api/useApi', () => ({ useApi: () => ({ getStats: mockGetStats }) }));

const EMPTY: StatsSummary = {
  played: 0, won: 0, lost: 0, marksWon: 0, bidsWon: 0, bidsMade: 0, bidsSet: 0,
  averagePointsBid: null, marksBids: 0, favoriteTrump: null, bestPartner: null,
};

const STATS: Stats = {
  all: { ...EMPTY, played: 5, won: 3, lost: 2, bidsWon: 9, favoriteTrump: { trump: 'sixes', times: 4 }, bestPartner: { user: { user_id: 's', displayName: 'Sam' }, won: 3, lost: 1 } },
  humansOnly: { ...EMPTY, played: 4, won: 3, lost: 1 },
  withBots: { ...EMPTY, played: 1, won: 0, lost: 1 },
};

async function renderStats() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(
    <QueryClientProvider client={client}>
      <PlayerStats />
    </QueryClientProvider>
  );
}

afterEach(() => mockGetStats.mockReset());

describe('PlayerStats', () => {
  it('shows All by default, with the best partner', async () => {
    mockGetStats.mockResolvedValue(STATS);
    await renderStats();

    expect(await screen.findByText('Sam')).toBeTruthy();
    expect(screen.getByLabelText('Played: 5')).toBeTruthy();
    expect(screen.getByLabelText('Win rate: 60%')).toBeTruthy();
    expect(screen.getByText('3–1 together')).toBeTruthy();
    expect(screen.getByText('Sixes')).toBeTruthy();
    expect(screen.getByText('4 of 9 bids')).toBeTruthy();
  });

  it('heads match figures apart from bidding', async () => {
    mockGetStats.mockResolvedValue(STATS);
    await renderStats();
    await screen.findByText('Sam');

    expect(screen.getByRole('header', { name: 'Matches' })).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Bidding' })).toBeTruthy();
  });

  it('switches figures with the filter', async () => {
    mockGetStats.mockResolvedValue(STATS);
    await renderStats();
    await screen.findByText('Sam');

    await fireEvent.press(screen.getByRole('radio', { name: 'With bots' }));

    expect(screen.getByLabelText('Played: 1')).toBeTruthy();
    expect(screen.queryByText('Sam')).toBeNull();
    expect(screen.queryByText('Sixes')).toBeNull();
  });

  it('invites a first match when nothing is counted yet', async () => {
    mockGetStats.mockResolvedValue({ all: EMPTY, humansOnly: EMPTY, withBots: EMPTY });
    await renderStats();
    expect(await screen.findByText('Finish a match to see your stats here.')).toBeTruthy();
  });

  it('shows an error without breaking the screen', async () => {
    mockGetStats.mockRejectedValue(new Error('Stats are down'));
    await renderStats();
    expect(await screen.findByText('Stats are down')).toBeTruthy();
  });
});
