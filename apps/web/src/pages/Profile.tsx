// The profile page: display name, picture URL, and game settings. Email is read-only, sourced straight from
// `getProfile()`'s response (never sent back via `patchProfile`). Picture is a plain URL text
// field (not a file upload) with a live preview that falls back to the profile's existing picture
// until edited. There's no theme setting: the whole site is the one dark domino-hall look
// (styles/hall.css).
//
// Below it, the Turn alerts card (components/TurnAlertSettings.tsx) - kept per browser and saved
// as it changes, not with this form. Above it, the Stats card (components/PlayerStats.tsx) - the
// player's own record, loaded on its own.
//
// A save confirms with a brief inline "Saved" message near the button, and an error shows as an
// inline banner.
//
// At the bottom, Delete account (DELETE /api/users/me): confirmed first, then the session ends and
// Auth0 sends the browser back to the start. A failure shows as the banner, to try again.
import { useEffect, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth0 } from '@auth0/auth0-react';
import { useGetToken } from '../auth/useGetToken';
import { apiClient } from '../api/client';
import { PlayerStats } from '../components/PlayerStats';
import { TurnAlertSettings } from '../components/TurnAlertSettings';
import './Profile.css';

const DELETE_ACCOUNT_CONFIRM =
  "Delete your account? Your friends, stats and invites are removed and bots take your seats in unfinished matches. Finished matches stay in other players' history as \"Unknown\". This can't be undone.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function Profile(): JSX.Element {
  const client = apiClient(useGetToken());

  const profileQuery = useQuery({ queryKey: ['profile'], queryFn: () => client.getProfile() });

  const [displayName, setDisplayName] = useState('');
  const [picture, setPicture] = useState('');
  const [highlightPlayable, setHighlightPlayable] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!profileQuery.data || initialized) return;
    const profile = profileQuery.data;
    setDisplayName(profile.displayName ?? '');
    setPicture(profile.picture ?? '');
    setHighlightPlayable(profile.highlightPlayable ?? false);
    setInitialized(true);
  }, [profileQuery.data, initialized]);

  const queryClient = useQueryClient();
  const saveMutation = useMutation({
    mutationFn: () =>
      client.patchProfile({
        displayName,
        picture,
        highlightPlayable,
      }),
    onSuccess: () => {
      // The match page reads the settings from this same query.
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1750);
    },
  });

  const { logout } = useAuth0();
  const deleteMutation = useMutation({
    mutationFn: () => client.deleteAccount(),
    onSuccess: () => logout({ logoutParams: { returnTo: window.location.origin } }),
  });
  const confirmDeleteAccount = (): void => {
    if (window.confirm(DELETE_ACCOUNT_CONFIRM)) deleteMutation.mutate();
  };

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
      {deleteMutation.isError && (
        <p role="alert" className="page-error">
          {errorMessage(deleteMutation.error)}
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
            maxLength={50}
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

        <label className="form-check" htmlFor="chkHighlightPlayable">
          <input
            type="checkbox"
            id="chkHighlightPlayable"
            checked={highlightPlayable}
            onChange={(e) => setHighlightPlayable(e.target.checked)}
          />
          <span>
            <span className="form-check-label">Highlight playable dominoes</span>
            <span className="form-check-hint">On your turn, outline the dominoes you can play and fade the rest.</span>
          </span>
        </label>


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

      <PlayerStats />

      <TurnAlertSettings />

      <div className="profile-delete">
        <button type="button" className="profile-delete-button" onClick={confirmDeleteAccount} disabled={deleteMutation.isPending}>
          {deleteMutation.isPending ? 'Deleting…' : 'Delete account'}
        </button>
      </div>
    </div>
  );
}
