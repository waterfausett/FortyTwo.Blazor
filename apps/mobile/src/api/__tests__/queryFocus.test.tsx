// Coming back to the app, or the network returning, refetches what's on screen; the match screen's
// socket-fed query is left alone, and so is the lobby while something else is open over it.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { focusManager, onlineManager, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { NetInfoState } from '@react-native-community/netinfo';
import { connectQueryFocus, refetchIfShowing, setLobbyShowing } from '../queryFocus';

let mockNetInfoListener: ((state: NetInfoState) => void) | null = null;
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn((listener: (state: NetInfoState) => void) => {
      mockNetInfoListener = listener;
      return jest.fn();
    }),
  },
}));

let appStateListener: ((state: AppStateStatus) => void) | null = null;

describe('connectQueryFocus', () => {
  let client: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

  beforeEach(() => {
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type: string, listener: unknown) => {
      appStateListener = listener as (state: AppStateStatus) => void;
      return { remove: jest.fn() };
    });
    connectQueryFocus();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: refetchIfShowing, refetchOnReconnect: refetchIfShowing } },
    });
  });

  afterEach(() => {
    client.clear();
    jest.restoreAllMocks();
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
    setLobbyShowing(true);
  });

  async function mounted(options: { queryKey?: string[]; refetchOnWindowFocus?: boolean; refetchOnReconnect?: boolean } = {}) {
    const queryFn = jest.fn(async () => 'data');
    const { result } = await renderHook(() => useQuery({ queryKey: ['thing'], queryFn, ...options }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    return queryFn;
  }

  it('refetches when the app comes back from the background', async () => {
    const queryFn = await mounted();
    await act(async () => appStateListener!('background'));
    expect(queryFn).toHaveBeenCalledTimes(1);
    await act(async () => appStateListener!('active'));
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });

  it("doesn't refetch for iOS's brief 'inactive'", async () => {
    const queryFn = await mounted();
    await act(async () => appStateListener!('inactive'));
    await act(async () => appStateListener!('active'));
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('refetches when the network comes back', async () => {
    const queryFn = await mounted();
    await act(async () => mockNetInfoListener!({ isConnected: false } as NetInfoState));
    await act(async () => mockNetInfoListener!({ isConnected: true } as NetInfoState));
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });

  it('leaves a query that opts out alone', async () => {
    const queryFn = await mounted({ refetchOnWindowFocus: false, refetchOnReconnect: false });
    await act(async () => appStateListener!('background'));
    await act(async () => appStateListener!('active'));
    await act(async () => mockNetInfoListener!({ isConnected: false } as NetInfoState));
    await act(async () => mockNetInfoListener!({ isConnected: true } as NetInfoState));
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('leaves the lobby alone while something else is open over it', async () => {
    const queryFn = await mounted({ queryKey: ['matches', 'Active'] });
    setLobbyShowing(false);
    await act(async () => appStateListener!('background'));
    await act(async () => appStateListener!('active'));
    await act(async () => mockNetInfoListener!({ isConnected: false } as NetInfoState));
    await act(async () => mockNetInfoListener!({ isConnected: true } as NetInfoState));
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('refetches the lobby when it is the screen showing', async () => {
    const queryFn = await mounted({ queryKey: ['matches', 'Active'] });
    await act(async () => appStateListener!('background'));
    await act(async () => appStateListener!('active'));
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });

  it('still refetches a screen of its own while the lobby is hidden', async () => {
    const queryFn = await mounted({ queryKey: ['stats'] });
    setLobbyShowing(false);
    await act(async () => appStateListener!('background'));
    await act(async () => appStateListener!('active'));
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });
});
