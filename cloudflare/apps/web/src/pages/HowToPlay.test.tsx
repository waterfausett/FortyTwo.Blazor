// Tests the How to play page: every section of the shared copy with an index, and opening it
// marking the rules seen (only when the profile says they weren't). Mocks `apiClient` and
// `useAuth0` the way Lobby.test.tsx does.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOW_TO_PLAY } from '@fortytwo/client';
import { NavBar } from '../components/NavBar';
import { HowToPlay } from './HowToPlay';

const { getProfileMock, patchProfileMock } = vi.hoisted(() => ({ getProfileMock: vi.fn(), patchProfileMock: vi.fn() }));

vi.mock('../api/client', () => ({
  apiClient: () => ({ getProfile: getProfileMock, patchProfile: patchProfileMock }),
}));

vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({ getAccessTokenSilently: vi.fn(async () => 'test-token') }),
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HowToPlay />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('HowToPlay page', () => {
  beforeEach(() => {
    patchProfileMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows every section, with an index linking to each', () => {
    getProfileMock.mockResolvedValue({ user_id: 'p1', displayName: 'Me', seenHowToPlay: true });
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'How to play' })).toBeTruthy();
    for (const section of HOW_TO_PLAY) {
      expect(screen.getByRole('heading', { name: section.title })).toBeTruthy();
      expect(screen.getByRole('link', { name: section.title }).getAttribute('href')).toBe(`#how-to-play-${section.id}`);
    }
  });

  it('names the dominoes in each example for screen readers', () => {
    getProfileMock.mockResolvedValue({ user_id: 'p1', displayName: 'Me', seenHowToPlay: true });
    renderPage();

    expect(screen.getByText('5-5, 6-4, 5-0, 4-1, 3-2')).toBeTruthy();
  });

  it('marks the rules seen once the profile says they were not', async () => {
    let resolve!: (profile: unknown) => void;
    getProfileMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderPage();

    // Still loading: nothing to save yet.
    expect(patchProfileMock).not.toHaveBeenCalled();
    resolve({ user_id: 'p1', displayName: 'Me', seenHowToPlay: false });
    await waitFor(() => expect(patchProfileMock).toHaveBeenCalledWith({ seenHowToPlay: true }));
    expect(patchProfileMock).toHaveBeenCalledTimes(1);
  });

  it('tries the save once per visit, even when it fails', async () => {
    getProfileMock.mockResolvedValue({ user_id: 'p1', displayName: 'Me', seenHowToPlay: false });
    // Fails a moment later, as a real request would.
    patchProfileMock.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error('offline')), 5)));
    renderPage();

    await waitFor(() => expect(patchProfileMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 200));
    expect(patchProfileMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['already seen', { user_id: 'p1', displayName: 'Me', seenHowToPlay: true }],
    ['from a worker that does not know the setting', { user_id: 'p1', displayName: 'Me' }],
  ])('saves nothing for a profile %s', async (_, profile) => {
    getProfileMock.mockResolvedValue(profile);
    renderPage();

    await waitFor(() => expect(getProfileMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(patchProfileMock).not.toHaveBeenCalled();
  });
});

describe('NavBar', () => {
  afterEach(cleanup);

  it('links to How to play', () => {
    render(
      <MemoryRouter>
        <NavBar />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'How to play' }).getAttribute('href')).toBe('/how-to-play');
  });
});
