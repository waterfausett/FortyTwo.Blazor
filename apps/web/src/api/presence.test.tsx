// PresenceProvider opens the presence socket only when the Worker says the online count is on
// (GET /api/config's `presence`, from PRESENCE_ENABLED, off by default).
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PresenceProvider, useOnline } from './presence';

const { connectPresenceSocketMock, getConfigMock } = vi.hoisted(() => ({
  connectPresenceSocketMock: vi.fn(() => () => {}),
  getConfigMock: vi.fn(),
}));

vi.mock('@fortytwo/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fortytwo/client')>()),
  connectPresenceSocket: connectPresenceSocketMock,
}));

vi.mock('./client', () => ({ apiClient: () => ({ getConfig: getConfigMock }) }));

vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({ getAccessTokenSilently: vi.fn(async () => 'test-token') }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Count() {
  const online = useOnline();
  return <p>{online === null ? 'no count' : `${online} online`}</p>;
}

function renderProvider() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PresenceProvider>
        <Count />
      </PresenceProvider>
    </QueryClientProvider>
  );
}

describe('PresenceProvider', () => {
  it('opens no socket while presence is off', async () => {
    getConfigMock.mockResolvedValue({ bots: true, presence: false });
    renderProvider();
    await waitFor(() => expect(getConfigMock).toHaveBeenCalled());
    expect(connectPresenceSocketMock).not.toHaveBeenCalled();
    expect(screen.getByText('no count')).toBeTruthy();
  });

  it('opens the socket once presence is on', async () => {
    getConfigMock.mockResolvedValue({ bots: true, presence: true });
    renderProvider();
    await waitFor(() => expect(connectPresenceSocketMock).toHaveBeenCalledTimes(1));
  });
});
