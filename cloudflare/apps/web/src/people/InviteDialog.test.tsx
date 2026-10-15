import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Person } from '@fortytwo/client';
import { InviteDialog } from './InviteDialog';

const people: Person[] = [
  { user_id: 'ann', displayName: 'Ann', isFriend: true, lastPlayedOn: null, games: 0 },
  { user_id: 'bo', displayName: 'Bo', isFriend: false, lastPlayedOn: null, games: 0 },
];

function setup(invitePlayers = vi.fn(async (_m: string, ids: string[]) => ({ invited: ids }))) {
  const client = {
    getPeople: vi.fn(async () => people),
    searchPeople: vi.fn(async () => []),
    addFriend: vi.fn(async () => {}),
    removeFriend: vi.fn(async () => {}),
    invitePlayers,
  };
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <InviteDialog open matchId="m1" seatedIds={['bo']} client={client} onClose={onClose} />
    </QueryClientProvider>
  );
  return { client, onClose };
}

afterEach(cleanup);

describe('InviteDialog', () => {
  it('invites a person, hiding anyone already seated', async () => {
    const { client } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Invite Ann' }));
    await waitFor(() => expect(client.invitePlayers).toHaveBeenCalledWith('m1', ['ann']));
    expect(await screen.findByText('Invited ✓')).toBeTruthy();
    expect(screen.queryByText('Bo')).toBeNull();
  });

  it('shows why an invite was refused', async () => {
    setup(vi.fn(async () => { throw new ApiError('Too many invites', 'A table can send at most 6 invites.', 409); }));
    fireEvent.click(await screen.findByRole('button', { name: 'Invite Ann' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Too many invites: A table can send at most 6 invites.');
  });

  it('closes on Escape', async () => {
    const { onClose } = setup();
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
