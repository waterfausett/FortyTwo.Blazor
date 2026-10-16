import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Text } from 'react-native';
import type { Invite, MatchSummary, Person } from '@fortytwo/client';
import { toastError } from '@/components/toast';
import { PeoplePanel } from '../PeoplePanel';
import { InvitesCard } from '../InvitesCard';
import { InviteSheet } from '../InviteSheet';
import { InviteToTableSheet } from '../InviteToTableSheet';
import { SafeAreaProvider } from 'react-native-safe-area-context';

const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockRouter.push(...a) } }));

const ann: Person = { user_id: 'ann', displayName: 'Ann', isFriend: true, lastPlayedOn: null, games: 0 };
const bo: Person = { user_id: 'bo', displayName: 'Bo', isFriend: false, lastPlayedOn: '2026-10-12T00:00:00.000Z', games: 2 };
const invite: Invite = { matchId: 'm1', from: { user_id: 'ann', displayName: 'Ann' }, createdOn: '2026-10-14T00:00:00.000Z', seatsOpen: 1 };

const table = (overrides: Partial<MatchSummary>): MatchSummary => ({
  id: 'm',
  status: 'active',
  playerCount: 2,
  updatedOn: '2026-10-16T00:00:00.000Z',
  teams: [['Me'], ['Ann']],
  seats: ['Me', null, 'Ann', null],
  mode: 'custom',
  ...overrides,
});

const mockApi = {
  listMatches: jest.fn(async () => ({
    matches: [table({ id: 'open' }), table({ id: 'async', mode: 'daily' }), table({ id: 'with-bo', seats: ['Me', 'Bo', null, null] })],
    nextCursor: null,
  })),
  getPeople: jest.fn(async () => [ann, bo]),
  searchPeople: jest.fn(async (q: string) => [ann, bo].filter((p) => p.displayName.toLowerCase().startsWith(q.toLowerCase()))),
  addFriend: jest.fn(async () => {}),
  removeFriend: jest.fn(async () => {}),
  getInvites: jest.fn(async () => [invite]),
  dismissInvite: jest.fn(async () => {}),
  invitePlayers: jest.fn(async (_m: string, ids: string[]) => ({ invited: ids })),
};
jest.mock('@/api/useApi', () => ({ useApi: () => mockApi }));
jest.mock('@/components/toast', () => ({ toastError: jest.fn() }));

async function show(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
  await render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => jest.clearAllMocks());

describe('PeoplePanel', () => {
  it('lists people, starring and unstarring', async () => {
    await show(<PeoplePanel emptyText="Nobody yet" />);
    expect(await screen.findByText('Ann')).toBeTruthy();
    expect(screen.getByText(/2 games/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Add Bo as a friend'));
    await waitFor(() => expect(mockApi.addFriend).toHaveBeenCalledWith('bo'));
    await fireEvent.press(screen.getByLabelText('Remove Ann from friends'));
    await waitFor(() => expect(mockApi.removeFriend).toHaveBeenCalledWith('ann'));
  });

  it('toasts when starring a player is refused', async () => {
    const refusal = new Error('Friend list is full');
    mockApi.addFriend.mockRejectedValueOnce(refusal);
    await show(<PeoplePanel emptyText="Nobody yet" />);
    await fireEvent.press(await screen.findByLabelText('Add Bo as a friend'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect((toastError as jest.Mock).mock.calls[0][0]).toBe(refusal);
  });

  it('searches once two characters are typed', async () => {
    await show(<PeoplePanel emptyText="Nobody yet" />);
    await screen.findByText('Ann');
    await fireEvent.changeText(screen.getByLabelText('Find a player'), 'bo');
    await waitFor(() => expect(mockApi.searchPeople).toHaveBeenCalledWith('bo'));
    await waitFor(() => expect(screen.queryByText('Ann')).toBeNull());
  });

  it('hides people and shows an action for each', async () => {
    await show(<PeoplePanel hiddenIds={['ann']} action={(p) => <Text>Invite {p.displayName}</Text>} emptyText="x" />);
    expect(await screen.findByText('Invite Bo')).toBeTruthy();
    expect(screen.queryByText('Ann')).toBeNull();
  });
});

describe('InvitesCard', () => {
  it('joins and dismisses', async () => {
    await show(<InvitesCard />);
    expect(await screen.findByText('Ann invited you')).toBeTruthy();
    expect(screen.getByText(/ago · 1 seat open$/)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Join'));
    expect(mockRouter.push).toHaveBeenCalledWith('/match/m1');
    await fireEvent.press(screen.getByLabelText('Dismiss invite from Ann'));
    await waitFor(() => expect(mockApi.dismissInvite).toHaveBeenCalledWith('m1'));
    await waitFor(() => expect(mockApi.getInvites).toHaveBeenCalledTimes(2));
  });

  it('toasts when dismissing is refused', async () => {
    const refusal = new Error('Not found');
    mockApi.dismissInvite.mockRejectedValueOnce(refusal);
    await show(<InvitesCard />);
    await fireEvent.press(await screen.findByLabelText('Dismiss invite from Ann'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect((toastError as jest.Mock).mock.calls[0][0]).toBe(refusal);
  });

  it('shows nothing without invites', async () => {
    mockApi.getInvites.mockResolvedValueOnce([]);
    await show(<InvitesCard />);
    await act(async () => {});
    expect(screen.queryByText(/invited you/)).toBeNull();
  });

  it('shows the newest three, and the rest behind Show N more', async () => {
    const names = ['Ann', 'Bo', 'Cy', 'Di', 'Ed'];
    const invites = names.map((n, i) => ({ ...invite, matchId: `m${i}`, from: { user_id: n.toLowerCase(), displayName: n } }));
    // Every fetch, not just the first: the card may refetch while the test runs.
    mockApi.getInvites.mockImplementation(async () => invites);
    try {
      await show(<InvitesCard />);
      expect(await screen.findByText('Cy invited you')).toBeTruthy();
      expect(screen.queryByText('Di invited you')).toBeNull();
      fireEvent.press(screen.getByText('Show 2 more'));
      expect(await screen.findByText('Ed invited you')).toBeTruthy();
      fireEvent.press(screen.getByText('Show fewer'));
      await waitFor(() => expect(screen.queryByText('Ed invited you')).toBeNull());
    } finally {
      mockApi.getInvites.mockImplementation(async () => [invite]);
    }
  });
});

describe('InviteSheet', () => {
  const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

  it('invites a person not already seated', async () => {
    await show(
      <SafeAreaProvider initialMetrics={metrics}>
        <InviteSheet visible matchId="m1" seatedIds={['bo']} onClose={jest.fn()} />
      </SafeAreaProvider>
    );
    await fireEvent.press(await screen.findByLabelText('Invite Ann'));
    await waitFor(() => expect(mockApi.invitePlayers).toHaveBeenCalledWith('m1', ['ann']));
    expect(await screen.findByText('Invited ✓')).toBeTruthy();
    expect(screen.queryByText('Bo')).toBeNull();
  });
});

describe('InviteToTableSheet', () => {
  const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
  it('lists only open Custom tables the person is not at, and invites to one', async () => {
    await show(
      <SafeAreaProvider initialMetrics={metrics}>
        <InviteToTableSheet person={bo} onClose={() => {}} />
      </SafeAreaProvider>
    );
    expect(await screen.findByText('2 seats open')).toBeTruthy();
    expect(screen.getAllByLabelText(/^Invite Bo to/)).toHaveLength(1);
    await fireEvent.press(screen.getByLabelText('Invite Bo to Me vs Ann'));
    await waitFor(() => expect(mockApi.invitePlayers).toHaveBeenCalledWith('open', ['bo']));
    expect(await screen.findByText('Invited ✓')).toBeTruthy();
  });

  it('says so when there is no open table', async () => {
    mockApi.listMatches.mockResolvedValueOnce({ matches: [table({ mode: 'daily' })], nextCursor: null });
    await show(
      <SafeAreaProvider initialMetrics={metrics}>
        <InviteToTableSheet person={bo} onClose={() => {}} />
      </SafeAreaProvider>
    );
    expect(await screen.findByText(/No open Custom tables/)).toBeTruthy();
  });
});
