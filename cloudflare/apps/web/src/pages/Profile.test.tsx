// Tests the Profile page: loads a profile via `getProfile()` on mount, populates the
// email (read-only)/picture/theme/displayName fields, and submits edited values via
// `patchProfile()`. `apiClient` is mocked at the module level, matching Lobby.test.tsx's/
// Match.test.tsx's established pattern (Profile.tsx calls `apiClient(getToken)` internally, so
// tests control `getProfile`/`patchProfile`'s mocked return/behavior directly). `vitest.config.ts`
// now has `test.globals: true` (Task 20's fix round), so RTL's automatic `afterEach(cleanup)`
// self-registers - no explicit `cleanup()` call is needed here (unlike Lobby.test.tsx/
// Match.test.tsx, which predate that fix).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Auth0User } from '../api/client';
import { Profile } from './Profile';

const { getProfileMock, patchProfileMock } = vi.hoisted(() => ({
  getProfileMock: vi.fn(),
  patchProfileMock: vi.fn(),
}));

vi.mock('../api/client', () => ({
  apiClient: () => ({
    getProfile: getProfileMock,
    patchProfile: patchProfileMock,
  }),
}));

vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({ getAccessTokenSilently: vi.fn(async () => 'test-token') }),
}));

const PROFILE_FIXTURE: Auth0User = {
  user_id: 'auth0|abc123',
  email: 'player@example.com',
  displayName: 'Old Name',
  picture: 'https://example.com/old-picture.png',
  user_metadata: { displayName: 'Old Name', theme: 'Light', picture: 'https://example.com/old-picture.png' },
};

function renderProfile() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Profile />
    </QueryClientProvider>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Profile', () => {
  it('loads the profile and populates the fields', async () => {
    getProfileMock.mockResolvedValue(PROFILE_FIXTURE);
    renderProfile();

    expect(screen.getByRole('status', { name: /loading/i })).not.toBeNull();

    const emailInput = (await screen.findByLabelText(/email/i)) as HTMLInputElement;
    expect(emailInput.value).toBe('player@example.com');
    expect(emailInput.disabled).toBe(true);

    const pictureInput = screen.getByLabelText(/picture/i) as HTMLInputElement;
    expect(pictureInput.value).toBe('https://example.com/old-picture.png');

    const displayNameInput = screen.getByLabelText(/display name/i) as HTMLInputElement;
    expect(displayNameInput.value).toBe('Old Name');

    const themeToggle = screen.getByLabelText(/dark theme/i) as HTMLInputElement;
    expect(themeToggle.checked).toBe(false);

    const preview = screen.getByAltText(/profile picture preview/i) as HTMLImageElement;
    expect(preview.src).toBe('https://example.com/old-picture.png');
  });

  it('updates the picture preview as the picture field is edited', async () => {
    getProfileMock.mockResolvedValue(PROFILE_FIXTURE);
    renderProfile();

    const pictureInput = (await screen.findByLabelText(/picture/i)) as HTMLInputElement;
    fireEvent.change(pictureInput, { target: { value: 'https://example.com/new-picture.png' } });

    const preview = screen.getByAltText(/profile picture preview/i) as HTMLImageElement;
    expect(preview.src).toBe('https://example.com/new-picture.png');
  });

  it('submits the form with edited values via patchProfile', async () => {
    getProfileMock.mockResolvedValue(PROFILE_FIXTURE);
    patchProfileMock.mockResolvedValue(undefined);
    renderProfile();

    const displayNameInput = (await screen.findByLabelText(/display name/i)) as HTMLInputElement;
    fireEvent.change(displayNameInput, { target: { value: 'New Name' } });

    const pictureInput = screen.getByLabelText(/picture/i) as HTMLInputElement;
    fireEvent.change(pictureInput, { target: { value: 'https://example.com/new-picture.png' } });

    const themeToggle = screen.getByLabelText(/dark theme/i) as HTMLInputElement;
    fireEvent.click(themeToggle);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(patchProfileMock).toHaveBeenCalledWith({
        displayName: 'New Name',
        theme: 'Dark',
        picture: 'https://example.com/new-picture.png',
      })
    );
  });

  it('shows a brief saved indicator after a successful save', async () => {
    getProfileMock.mockResolvedValue(PROFILE_FIXTURE);
    patchProfileMock.mockResolvedValue(undefined);
    renderProfile();

    await screen.findByLabelText(/display name/i);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(patchProfileMock).toHaveBeenCalled());
    expect(await screen.findByText(/saved/i)).not.toBeNull();
  });

  it('surfaces a patchProfile error as a visible inline banner', async () => {
    getProfileMock.mockResolvedValue(PROFILE_FIXTURE);
    patchProfileMock.mockRejectedValue(new Error('Something went wrong.'));
    renderProfile();

    await screen.findByLabelText(/display name/i);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/something went wrong/i);
  });
});
