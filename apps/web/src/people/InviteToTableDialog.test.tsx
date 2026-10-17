import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type MatchSummary, type Person } from '@fortytwo/client';
import { InviteToTableDialog } from './InviteToTableDialog';

const bo: Person = { user_id: 'bo', displayName: 'Bo', isFriend: true, lastPlayedOn: null, games: 0 };

const table = (overrides: Partial<MatchSummary>): MatchSummary => ({
  id: 'm',
  status: 'active',
  playerCount: 2,
  updatedOn: '2026-10-16T00:00:00Z',
  teams: [['Me'], ['Ann']],
  seats: ['Me', null, 'Ann', null],
  mode: 'custom',
  ...overrides,
});

function setup({
  matches = [table({ id: 'open' }), table({ id: 'async', mode: 'daily' }), table({ id: 'with-bo', seats: ['Me', 'Bo', null, null] })],
  invitePlayers = vi.fn(async (_m: string, ids: string[]) => ({ invited: ids })),
}: { matches?: MatchSummary[]; invitePlayers?: (m: string, ids: string[]) => Promise<{ invited: string[] }> } = {}) {
  const client = { listMatches: vi.fn(async () => ({ matches, nextCursor: null })), invitePlayers };
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <InviteToTableDialog person={bo} client={client} onClose={onClose} />
    </QueryClientProvider>
  );
  return { client, onClose };
}

afterEach(cleanup);

describe('InviteToTableDialog', () => {
  it('lists only open Custom tables the person is not at, and invites to one', async () => {
    const { client } = setup();
    expect(await screen.findByText('2 seats open')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Invite Bo to/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Invite Bo to Me vs Ann' }));
    await waitFor(() => expect(client.invitePlayers).toHaveBeenCalledWith('open', ['bo']));
    expect(await screen.findByText('Invited ✓')).toBeTruthy();
    expect(client.listMatches).toHaveBeenCalledWith('Active');
  });

  it('says so when there is no open table', async () => {
    setup({ matches: [table({ mode: 'daily' })] });
    expect(await screen.findByText(/No open Custom tables/)).toBeTruthy();
  });

  it('shows why an invite was refused', async () => {
    setup({ invitePlayers: vi.fn(async () => { throw new ApiError('Too many invites', 'A table can send at most 6 invites.', 409); }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Invite Bo to Me vs Ann' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Too many invites: A table can send at most 6 invites.');
  });

  it('closes on Escape', async () => {
    const { onClose } = setup();
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
