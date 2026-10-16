import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Invite, Person } from '@fortytwo/client';
import { PeoplePanel } from './PeoplePanel';
import { InvitesCard } from './InvitesCard';

const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }));
vi.mock('../ui/toast', () => ({ toastError: toastErrorMock }));

const ann: Person = { user_id: 'ann', displayName: 'Ann', isFriend: true, lastPlayedOn: null, games: 0 };
const bo: Person = { user_id: 'bo', displayName: 'Bo', isFriend: false, lastPlayedOn: '2026-10-12T00:00:00.000Z', games: 2 };

function client(people: Person[] = [ann, bo]) {
  return {
    getPeople: vi.fn(async () => people),
    searchPeople: vi.fn(async (q: string) => people.filter((p) => p.displayName.toLowerCase().startsWith(q.toLowerCase()))),
    addFriend: vi.fn(async () => {}),
    removeFriend: vi.fn(async () => {}),
  };
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  toastErrorMock.mockClear();
  vi.useRealTimers();
});

describe('PeoplePanel', () => {
  it('lists friends and recent players, starring and unstarring', async () => {
    const c = client();
    wrap(<PeoplePanel client={c} emptyText="Nobody yet" />);
    expect(await screen.findByText('Ann')).toBeTruthy();
    expect(screen.getByText(/2 games/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ann from friends' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Bo as a friend' }));
    await waitFor(() => expect(c.removeFriend).toHaveBeenCalledWith('ann'));
    expect(c.addFriend).toHaveBeenCalledWith('bo');
  });

  it('toasts when starring a player is refused', async () => {
    const c = client();
    const refusal = new Error('Friend list is full');
    c.addFriend.mockRejectedValueOnce(refusal);
    wrap(<PeoplePanel client={c} emptyText="Nobody yet" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Bo as a friend' }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(toastErrorMock.mock.calls[0][0]).toBe(refusal);
  });

  it('searches once two characters are typed', async () => {
    const c = client();
    wrap(<PeoplePanel client={c} emptyText="Nobody yet" />);
    await screen.findByText('Ann');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a player' }), { target: { value: 'bo' } });
    await waitFor(() => expect(c.searchPeople).toHaveBeenCalledWith('bo'));
    await waitFor(() => expect(screen.queryByText('Ann')).toBeNull());
  });

  it('hides people and shows an action for each', async () => {
    wrap(<PeoplePanel client={client()} hiddenIds={['ann']} action={(p) => <button>Invite {p.displayName}</button>} emptyText="x" />);
    expect(await screen.findByRole('button', { name: 'Invite Bo' })).toBeTruthy();
    expect(screen.queryByText('Ann')).toBeNull();
  });

  it('shows the empty text', async () => {
    wrap(<PeoplePanel client={client([])} emptyText="Nobody yet" />);
    expect(await screen.findByText('Nobody yet')).toBeTruthy();
  });
});

describe('InvitesCard', () => {
  const invite: Invite = { matchId: 'm1', from: { user_id: 'ann', displayName: 'Ann' }, createdOn: '2026-10-14T00:00:00.000Z', seatsOpen: 2 };

  it('shows each invite with Join and Dismiss', async () => {
    const c = { getInvites: vi.fn(async () => [invite]), dismissInvite: vi.fn(async () => {}) };
    wrap(<InvitesCard client={c} />);
    expect(await screen.findByText('Ann invited you')).toBeTruthy();
    expect(screen.getByText(/ago · 2 seats open$/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Join' }).getAttribute('href')).toBe('/match/m1');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss invite from Ann' }));
    await waitFor(() => expect(c.dismissInvite).toHaveBeenCalledWith('m1'));
  });

  it('toasts when dismissing is refused', async () => {
    const refusal = new Error('Not found');
    const c = { getInvites: vi.fn(async () => [invite]), dismissInvite: vi.fn(async () => { throw refusal; }) };
    wrap(<InvitesCard client={c} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss invite from Ann' }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(toastErrorMock.mock.calls[0][0]).toBe(refusal);
  });

  it('shows nothing without invites', async () => {
    const c = { getInvites: vi.fn(async () => []), dismissInvite: vi.fn() };
    const { container } = wrap(<InvitesCard client={c} />);
    await act(async () => {});
    expect(container.textContent).toBe('');
  });

  it('shows the newest three, and the rest behind Show N more', async () => {
    const invites = ['Ann', 'Bo', 'Cy', 'Di', 'Ed'].map((n, i) => ({
      ...invite,
      matchId: `m${i}`,
      from: { user_id: n.toLowerCase(), displayName: n },
    }));
    const c = { getInvites: vi.fn(async () => invites), dismissInvite: vi.fn() };
    wrap(<InvitesCard client={c} />);
    expect(await screen.findByText('Cy invited you')).toBeTruthy();
    expect(screen.queryByText('Di invited you')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(screen.getByText('Ed invited you')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.queryByText('Ed invited you')).toBeNull();
  });
});
