import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Text } from 'react-native';
import type { Invite, Person } from '@fortytwo/client';
import { PeoplePanel } from '../PeoplePanel';
import { InvitesCard } from '../InvitesCard';
import { InviteSheet } from '../InviteSheet';
import { SafeAreaProvider } from 'react-native-safe-area-context';

const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockRouter.push(...a) } }));

const ann: Person = { user_id: 'ann', displayName: 'Ann', isFriend: true, lastPlayedOn: null, games: 0 };
const bo: Person = { user_id: 'bo', displayName: 'Bo', isFriend: false, lastPlayedOn: '2026-10-12T00:00:00.000Z', games: 2 };
const invite: Invite = { matchId: 'm1', from: { user_id: 'ann', displayName: 'Ann' }, createdOn: '2026-10-14T00:00:00.000Z', seatsOpen: 1 };

const mockApi = {
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
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => jest.clearAllMocks());

describe('PeoplePanel', () => {
  it('lists people, starring and unstarring', async () => {
    await show(<PeoplePanel emptyText="Nobody yet" />);
    expect(await screen.findByText('Ann')).toBeTruthy();
    expect(screen.getByText(/2 games/)).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Add Bo as a friend'));
    await waitFor(() => expect(mockApi.addFriend).toHaveBeenCalledWith('bo'));
    fireEvent.press(screen.getByLabelText('Remove Ann from friends'));
    await waitFor(() => expect(mockApi.removeFriend).toHaveBeenCalledWith('ann'));
  });

  it('searches once two characters are typed', async () => {
    await show(<PeoplePanel emptyText="Nobody yet" />);
    await screen.findByText('Ann');
    fireEvent.changeText(screen.getByLabelText('Find a player'), 'bo');
    await waitFor(() => expect(mockApi.searchPeople).toHaveBeenCalledWith('bo'));
    await waitFor(() => expect(screen.queryByText('Ann')).toBeNull());
  });

  it('hides people and shows an action for each', async () => {
    await show(<PeoplePanel hiddenIds={['ann']} action={(p) => <Text>Invite {p.displayName}</Text>} emptyText="x" />);
    expect(await screen.findByText('Invite Bo')).toBeTruthy();
    expect(screen.queryByText('Ann')).toBeNull();
  });
});

// Kept ahead of InvitesCard: after that suite's dismiss test, a later render never
// commits (cause not found), so this runs first.
describe('InviteSheet', () => {
  const metrics = { frame: { x: 0, y: 0, width: 390, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

  it('invites a person not already seated', async () => {
    await show(
      <SafeAreaProvider initialMetrics={metrics}>
        <InviteSheet visible matchId="m1" seatedIds={['bo']} onClose={jest.fn()} />
      </SafeAreaProvider>
    );
    fireEvent.press(await screen.findByLabelText('Invite Ann'));
    await waitFor(() => expect(mockApi.invitePlayers).toHaveBeenCalledWith('m1', ['ann']));
    expect(await screen.findByText('Invited ✓')).toBeTruthy();
    expect(screen.queryByText('Bo')).toBeNull();
  });
});

describe('InvitesCard', () => {
  it('joins and dismisses', async () => {
    await show(<InvitesCard />);
    expect(await screen.findByText('Ann invited you')).toBeTruthy();
    expect(screen.getByText('1 seat open')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Join'));
    expect(mockRouter.push).toHaveBeenCalledWith('/match/m1');
    fireEvent.press(screen.getByLabelText('Dismiss invite from Ann'));
    await waitFor(() => expect(mockApi.dismissInvite).toHaveBeenCalledWith('m1'));
  });

  it('shows nothing without invites', async () => {
    mockApi.getInvites.mockResolvedValueOnce([]);
    await show(<InvitesCard />);
    await act(async () => {});
    expect(screen.queryByText(/invited you/)).toBeNull();
  });
});
