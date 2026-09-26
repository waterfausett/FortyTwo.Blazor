// The profile page: display name and picture URL. Replaces
// FortyTwo/Client/Pages/Profile.razor(.cs). Email is read-only, sourced straight from
// `getProfile()`'s response (never sent back via `patchProfile`). Picture is a plain URL text
// field (despite the old app's <label for="filePicture">Picture</label>, it was never a file
// upload - `ProfileModel.Picture` is a string, and `InputText` posts a URL) with a live preview
// that falls back to the profile's existing picture until edited. The old app's light/dark theme
// toggle is gone: the whole site is the one dark domino-hall look (styles/hall.css).
//
// The old app used a SweetAlert2 toast on save; per this plan's established pattern (Task 20 used
// a plain inline banner for errors instead of a toast library), a brief inline "Saved" message
// near the button stands in for it - no new dependency.
import { useEffect, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useGetToken } from '../auth/useGetToken';
import { apiClient } from '../api/client';
import './Profile.css';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function Profile(): JSX.Element {
  const client = apiClient(useGetToken());

  const profileQuery = useQuery({ queryKey: ['profile'], queryFn: () => client.getProfile() });

  const [displayName, setDisplayName] = useState('');
  const [picture, setPicture] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!profileQuery.data || initialized) return;
    const profile = profileQuery.data;
    setDisplayName(profile.displayName ?? '');
    setPicture(profile.picture ?? '');
    setInitialized(true);
  }, [profileQuery.data, initialized]);

  const saveMutation = useMutation({
    mutationFn: () =>
      client.patchProfile({
        displayName,
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
      <div className="profile">
        <p role="alert" className="page-error">
          {errorMessage(profileQuery.error)}
        </p>
      </div>
    );
  }

  const previewSrc = picture.trim() !== '' ? picture : profileQuery.data?.picture ?? '';

  return (
    <div className="profile">
      <h1 className="page-title">Profile</h1>

      {saveMutation.isError && (
        <p role="alert" className="page-error">
          {errorMessage(saveMutation.error)}
        </p>
      )}

      <form className="profile-card mat-panel" onSubmit={handleSubmit}>
        <div className="profile-plate">
          {previewSrc !== '' ? (
            <img className="profile-picture-preview" src={previewSrc} alt="Profile picture preview" />
          ) : (
            <span className="profile-picture-preview profile-picture-empty" aria-hidden="true" />
          )}
          <div className="profile-plate-text">
            <span className="profile-plate-name">{displayName.trim() || 'No display name'}</span>
            <span className="profile-plate-email">{profileQuery.data?.email}</span>
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="txtDisplayName">Display name</label>
          <input
            type="text"
            id="txtDisplayName"
            placeholder="What the table calls you"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label htmlFor="txtPicture">Picture URL</label>
          <input
            type="text"
            id="txtPicture"
            placeholder="Default account picture"
            value={picture}
            onChange={(e) => setPicture(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label htmlFor="txtEmail">Email address</label>
          <input type="email" id="txtEmail" value={profileQuery.data?.email ?? ''} disabled />
        </div>


        <div className="profile-actions">
          <button type="submit" className="action-button" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving…' : 'Save changes'}
          </button>
          {justSaved && (
            <span className="profile-saved" role="status">
              Saved
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
