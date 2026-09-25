// The profile page: display name, picture URL, and a light/dark theme toggle. Replaces
// FortyTwo/Client/Pages/Profile.razor(.cs). Email is read-only, sourced straight from
// `getProfile()`'s response (never sent back via `patchProfile`). Picture is a plain URL text
// field (despite the old app's <label for="filePicture">Picture</label>, it was never a file
// upload - `ProfileModel.Picture` is a string, and `InputText` posts a URL) with a live preview
// that falls back to the profile's existing picture until edited. Theme is a checkbox
// (`UseDarkTheme: bool?` in the old `ProfileModel`), mapped to/from `client.ts`'s
// `theme: 'Light' | 'Dark'` string: checked -> 'Dark', unchecked -> 'Light'. On first load, if the
// profile has no theme set yet, this defaults the toggle to the OS preference (the React
// equivalent of the old app's `getSystemPrefersDarkTheme` JS interop call), matching
// Profile.razor.cs:35-37's `User.UserMetadata.Theme ??= ...`.
//
// The old app used a SweetAlert2 toast on save; per this plan's established pattern (Task 20 used
// a plain inline banner for errors instead of a toast library), a brief inline "Saved" message
// near the button stands in for it - no new dependency.
import { useEffect, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useAuth0 } from '@auth0/auth0-react';
import { apiClient } from '../api/client';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function systemPrefersDarkTheme(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

export function Profile(): JSX.Element {
  const { getAccessTokenSilently } = useAuth0();
  // Mirrors Lobby.tsx's/Match.tsx's getToken wrapper: auth0-react's getAccessTokenSilently is
  // typed to possibly resolve undefined, while apiClient's getToken param is a plain
  // () => Promise<string> - fail loudly rather than send `Authorization: Bearer undefined`.
  const client = apiClient(async () => {
    const token = await getAccessTokenSilently();
    if (!token) throw new Error('Failed to obtain an access token.');
    return token;
  });

  const profileQuery = useQuery({ queryKey: ['profile'], queryFn: () => client.getProfile() });

  const [displayName, setDisplayName] = useState('');
  const [picture, setPicture] = useState('');
  const [useDarkTheme, setUseDarkTheme] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!profileQuery.data || initialized) return;
    const profile = profileQuery.data;
    setDisplayName(profile.displayName ?? '');
    setPicture(profile.picture ?? '');
    const theme = profile.user_metadata?.theme ?? (systemPrefersDarkTheme() ? 'Dark' : 'Light');
    setUseDarkTheme(theme === 'Dark');
    setInitialized(true);
  }, [profileQuery.data, initialized]);

  const saveMutation = useMutation({
    mutationFn: () =>
      client.patchProfile({
        displayName,
        theme: useDarkTheme ? 'Dark' : 'Light',
        picture,
      }),
    onSuccess: () => {
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1750);
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setJustSaved(false);
    saveMutation.mutate();
  };

  if (profileQuery.isLoading) {
    return <div className="spinner" role="status" aria-label="Loading" />;
  }

  if (profileQuery.error != null) {
    return (
      <p role="alert" className="profile-error">
        {errorMessage(profileQuery.error)}
      </p>
    );
  }

  const previewSrc = picture.trim() !== '' ? picture : profileQuery.data?.picture ?? '';

  return (
    <div className="profile">
      <h3>Profile</h3>
      <hr />

      {saveMutation.isError && (
        <p role="alert" className="profile-error">
          {errorMessage(saveMutation.error)}
        </p>
      )}

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="txtEmail">Email address</label>
          <input type="email" id="txtEmail" value={profileQuery.data?.email ?? ''} disabled />
        </div>

        <div className="form-group">
          <label htmlFor="txtPicture">Picture</label>
          <input
            type="text"
            id="txtPicture"
            placeholder="Default account picture"
            value={picture}
            onChange={(e) => setPicture(e.target.value)}
          />
          {previewSrc !== '' && (
            <img className="profile-picture-preview" src={previewSrc} alt="Profile picture preview" />
          )}
        </div>

        <div className="form-group">
          <label htmlFor="chkDarkMode">Use Dark Theme</label>
          <input
            type="checkbox"
            id="chkDarkMode"
            checked={useDarkTheme}
            onChange={(e) => setUseDarkTheme(e.target.checked)}
          />
        </div>

        <div className="form-group">
          <label htmlFor="txtDisplayName">Display Name</label>
          <input
            type="text"
            id="txtDisplayName"
            placeholder="Display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div className="profile-actions">
          <button type="submit" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving' : 'Save'}
          </button>
          {justSaved && <span className="profile-saved">Saved</span>}
        </div>
      </form>
    </div>
  );
}
