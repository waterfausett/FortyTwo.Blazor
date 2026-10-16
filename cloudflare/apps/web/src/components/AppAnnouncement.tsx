// "Forty-Two is coming to your phone": the store badges for the Android and iOS apps, dimmed under a
// Coming soon pill, for the Lobby. Not links - there is nothing in either store yet. When the apps
// ship, give each badge its store URL (an <a>) and drop the pill. Dismissal is a per-browser
// convenience kept in localStorage; storage that throws just means the card shows every visit.
import { useState } from 'react';
import type { JSX } from 'react';
import './AppAnnouncement.css';

const DISMISSED_KEY = 'fortytwo.appAnnouncementDismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function PlayGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M4 2.5v19l10-9.5z" fill="#00d2ff" />
      <path d="M4 2.5 16.5 9 14 12z" fill="#00f076" />
      <path d="M4 21.5 16.5 15 14 12z" fill="#ff3a44" />
      <path d="M16.5 9 21 11.5c.7.4.7 1.1 0 1.5L16.5 15 14 12z" fill="#ffd500" />
    </svg>
  );
}

function AppleGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="#fff">
      <path d="M16.4 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.800-1.400-.1-2.800.9-3.5.9s-1.800-.8-3-.8c-1.600 0-3 .9-3.8 2.300-1.600 2.800-.4 7 1.200 9.300.8 1.100 1.700 2.400 2.900 2.300 1.200 0 1.600-.7 3-.7s1.800.7 3 .7 2-1.100 2.800-2.200c.9-1.300 1.200-2.500 1.300-2.600-.1 0-2.500-1-2.500-3.900zM14.100 5.900c.6-.8 1.100-1.900.9-3-.9 0-2.100.6-2.800 1.400-.6.7-1.100 1.800-1 2.900 1.100.1 2.200-.5 2.900-1.300z" />
    </svg>
  );
}

const BADGES = [
  { id: 'android', small: 'GET IT ON', big: 'Google Play', glyph: <PlayGlyph /> },
  { id: 'ios', small: 'Download on the', big: 'App Store', glyph: <AppleGlyph /> },
];

export function AppAnnouncement(): JSX.Element | null {
  const [dismissed, setDismissed] = useState(readDismissed);
  if (dismissed) return null;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Nothing to do: it just comes back next visit.
    }
  }

  return (
    <section className="app-announcement" aria-label="Mobile apps">
      <button type="button" className="app-announcement-dismiss" aria-label="Dismiss app announcement" onClick={dismiss}>
        ×
      </button>
      <p className="app-announcement-title">Forty-Two is coming to your phone</p>
      <div className="app-announcement-badges">
        {BADGES.map((badge) => (
          <div key={badge.id} className="app-badge" role="img" aria-label={`${badge.big}, coming soon`}>
            <span className="app-badge-body" aria-hidden="true">
              {badge.glyph}
              <span className="app-badge-text">
                <span className="app-badge-small">{badge.small}</span>
                <span className="app-badge-big">{badge.big}</span>
              </span>
            </span>
            <span className="app-badge-soon" aria-hidden="true">
              Coming soon
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
