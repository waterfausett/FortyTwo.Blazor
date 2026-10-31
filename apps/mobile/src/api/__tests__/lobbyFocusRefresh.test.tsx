// Back on the lobby, whichever segment is showing is fetched again once it's more than 30s old.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Lobby from '@/app/index';

let mockFocus: () => void = () => {};
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  Stack: { Screen: () => null },
  useFocusEffect: (effect: () => void) => {
    mockFocus = effect;
  },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/api/presence', () => ({ useOnline: () => 0 }));
jest.mock('@/api/useHowToPlay', () => ({ useHowToPlay: () => ({ offer: false, markSeen: jest.fn() }) }));
jest.mock('@/api/useProfile', () => ({ useProfile: () => ({ data: undefined }) }));
jest.mock('@/components/NewMatchSheet', () => ({ NewMatchSheet: () => null }));
jest.mock('@/people/InviteToTableSheet', () => ({ InviteToTableSheet: () => null }));

const mockApi = {
  listMatches: jest.fn(async () => ({ matches: [], nextCursor: null })),
  getPeople: jest.fn(async () => []),
  searchPeople: jest.fn(async () => []),
  getInvites: jest.fn(async () => []),
  getConfig: jest.fn(async () => ({})),
};
jest.mock('@/api/useApi', () => ({ useApi: () => mockApi }));

const LATER = 31_000;

// The fetches done and the screen rendered with them: the query cache gets there first.
async function settled(client: QueryClient) {
  await waitFor(() => expect(client.isFetching()).toBe(0));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('coming back to the lobby', () => {
  let client: QueryClient;
  const realNow = Date.now;

  beforeEach(async () => {
    jest.clearAllMocks();
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    await render(
      <QueryClientProvider client={client}>
        <Lobby />
      </QueryClientProvider>
    );
    await waitFor(() => expect(mockApi.listMatches).toHaveBeenCalled());
    await settled(client);
  });

  afterEach(() => {
    Date.now = realNow;
    client.clear();
  });

  async function segment(label: string) {
    await fireEvent.press(screen.getByText(label));
    await settled(client);
    jest.clearAllMocks();
  }

  async function backAfter(ms: number) {
    const now = realNow() + ms;
    Date.now = () => now;
    await act(async () => mockFocus());
    await settled(client);
  }

  it('leaves a list fetched moments ago', async () => {
    await segment('History');
    await backAfter(0);
    expect(mockApi.listMatches).not.toHaveBeenCalled();
    expect(mockApi.getInvites).not.toHaveBeenCalled();
  });

  it('refreshes Active once it is old', async () => {
    jest.clearAllMocks();
    await backAfter(LATER);
    expect(mockApi.listMatches).toHaveBeenCalledWith('Active', undefined);
    expect(mockApi.getInvites).toHaveBeenCalled();
  });

  it('refreshes History once it is old', async () => {
    await segment('History');
    await backAfter(LATER);
    expect(mockApi.listMatches).toHaveBeenCalledWith('Completed', undefined);
    expect(mockApi.getInvites).toHaveBeenCalled();
  });

  it('refreshes Friends once it is old', async () => {
    await segment('Friends');
    await backAfter(LATER);
    expect(mockApi.getPeople).toHaveBeenCalledTimes(1);
    expect(mockApi.getInvites).toHaveBeenCalled();
    expect(mockApi.listMatches).not.toHaveBeenCalled();
  });

  it('leaves Friends fetched moments ago', async () => {
    await segment('Friends');
    await backAfter(0);
    expect(mockApi.getPeople).not.toHaveBeenCalled();
  });
});
