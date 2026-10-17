// PresenceProvider opens the presence socket only when signed in, in the foreground, and the
// Worker has the online count switched on (GET /api/config's `presence`, off by default).
import { render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PresenceProvider, useOnline } from '../presence';

const mockConnectPresenceSocket = jest.fn(() => () => {});
jest.mock('@fortytwo/client', () => ({
  ...jest.requireActual('@fortytwo/client'),
  connectPresenceSocket: (...args: unknown[]) => mockConnectPresenceSocket(...(args as [])),
}));

const mockGetConfig = jest.fn();
jest.mock('@/api/useApi', () => ({ useApi: () => ({ getConfig: mockGetConfig }) }));
jest.mock('@/auth/useGetToken', () => ({ useGetToken: () => async () => 'test-token' }));
jest.mock('@/api/useMatchSocket', () => ({
  subscribeNetworkWake: () => () => {},
  useAppInForeground: () => true,
}));
jest.mock('@/config', () => ({ config: { wsOrigin: 'wss://api.test.local' } }));

afterEach(() => jest.clearAllMocks());

function Count() {
  const online = useOnline();
  return <Text>{online === null ? 'no count' : `${online} online`}</Text>;
}

async function renderProvider(enabled = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={queryClient}>
      <PresenceProvider enabled={enabled}>
        <Count />
      </PresenceProvider>
    </QueryClientProvider>
  );
}

describe('PresenceProvider', () => {
  it('opens no socket while presence is off', async () => {
    mockGetConfig.mockResolvedValue({ bots: true, presence: false });
    await renderProvider();
    await waitFor(() => expect(mockGetConfig).toHaveBeenCalled());
    expect(mockConnectPresenceSocket).not.toHaveBeenCalled();
    expect(screen.getByText('no count')).toBeTruthy();
  });

  it('opens the socket once presence is on', async () => {
    mockGetConfig.mockResolvedValue({ bots: true, presence: true });
    await renderProvider();
    await waitFor(() => expect(mockConnectPresenceSocket).toHaveBeenCalledTimes(1));
  });

  it('opens no socket while signed out, even with presence on', async () => {
    mockGetConfig.mockResolvedValue({ bots: true, presence: true });
    await renderProvider(false);
    expect(mockConnectPresenceSocket).not.toHaveBeenCalled();
  });
});
