import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerStats as Stats, StatsSummary } from '@fortytwo/api-types';
import { PlayerStats } from './PlayerStats';

const { getStatsMock } = vi.hoisted(() => ({ getStatsMock: vi.fn() }));

vi.mock('../api/client', () => ({ apiClient: () => ({ getStats: getStatsMock }) }));
vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({ getAccessTokenSilently: vi.fn(async () => 'test-token') }),
}));

const EMPTY: StatsSummary = {
  played: 0, won: 0, lost: 0, marksWon: 0, bidsWon: 0, bidsMade: 0, bidsSet: 0,
  averagePointsBid: null, marksBids: 0, favoriteTrump: null, bestPartner: null,
};

const STATS: Stats = {
  all: { ...EMPTY, played: 5, won: 3, lost: 2, bidsWon: 9, favoriteTrump: { trump: 'sixes', times: 4 }, bestPartner: { user: { user_id: 's', displayName: 'Sam' }, won: 3, lost: 1 } },
  humansOnly: { ...EMPTY, played: 4, won: 3, lost: 1 },
  withBots: { ...EMPTY, played: 1, won: 0, lost: 1 },
};

function renderStats() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PlayerStats />
    </QueryClientProvider>
  );
}

function tile(label: string): string | null {
  return screen.getByText(label).closest('.stat-tile')?.querySelector('.stat-value')?.textContent ?? null;
}

afterEach(() => vi.clearAllMocks());

describe('PlayerStats', () => {
  it('shows All by default, with the best partner', async () => {
    getStatsMock.mockResolvedValue(STATS);
    renderStats();

    expect(await screen.findByText('Sam')).not.toBeNull();
    expect(tile('Matches played')).toBe('5');
    expect(tile('Win rate')).toBe('60%');
    expect(screen.getByText('3–1 together')).not.toBeNull();
    expect(screen.getByText('Sixes')).not.toBeNull();
    expect(screen.getByText('4 of 9 bids')).not.toBeNull();
  });

  it('switches figures with the filter', async () => {
    getStatsMock.mockResolvedValue(STATS);
    renderStats();
    await screen.findByText('Sam');

    fireEvent.click(screen.getByLabelText('With bots'));

    expect(tile('Matches played')).toBe('1');
    expect(tile('Win rate')).toBe('0%');
    expect(screen.queryByText('Sam')).toBeNull();
    expect(screen.queryByText('Sixes')).toBeNull();
  });

  it('invites a first match when nothing is counted yet', async () => {
    getStatsMock.mockResolvedValue({ all: EMPTY, humansOnly: EMPTY, withBots: EMPTY });
    renderStats();
    expect(await screen.findByText('Finish a match to see your stats here.')).not.toBeNull();
  });

  it('shows an error without breaking the page', async () => {
    getStatsMock.mockRejectedValue(new Error('Stats are down'));
    renderStats();
    expect((await screen.findByRole('alert')).textContent).toContain('Stats are down');
  });
});
