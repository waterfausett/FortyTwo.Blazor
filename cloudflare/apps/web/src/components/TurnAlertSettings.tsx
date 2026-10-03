// The Profile page's "Turn alerts" card: how match/TurnAlerts.tsx should tell this player their
// turn has come. Kept per browser (match/alertPrefs.ts), so each change saves on the spot rather
// than with the profile form.
//
// Desktop notifications need the browser's say-so as well; switching them on asks for it (browsers
// only allow that from a click), and a refusal leaves them off with a note on where to undo it.
import { useState } from 'react';
import type { JSX } from 'react';
import type { AlertPrefs, SoundMode } from '../match/alertPrefs';
import { readAlertPrefs, writeAlertPrefs } from '../match/alertPrefs';
import { playChime } from '../ui/chime';

const SOUND_OPTIONS: { mode: SoundMode; label: string }[] = [
  { mode: 'off', label: 'Off' },
  { mode: 'away', label: "When I'm away" },
  { mode: 'always', label: 'Always' },
];

type Support = NotificationPermission | 'unsupported';

function notificationSupport(): Support {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export function TurnAlertSettings(): JSX.Element {
  const [prefs, setPrefs] = useState<AlertPrefs>(readAlertPrefs);
  const [support, setSupport] = useState<Support>(notificationSupport);

  function save(next: AlertPrefs): void {
    writeAlertPrefs(next);
    setPrefs(next);
  }

  function chooseSound(sound: SoundMode): void {
    save({ ...prefs, sound });
    if (sound !== 'off') playChime();
  }

  async function toggleDesktop(on: boolean): Promise<void> {
    if (!on) {
      save({ ...prefs, desktop: false });
      return;
    }
    const permission = support === 'granted' ? 'granted' : await Notification.requestPermission();
    setSupport(permission);
    if (permission === 'granted') save({ ...prefs, desktop: true });
  }

  const desktopNote =
    support === 'unsupported'
      ? "This browser doesn't support notifications."
      : support === 'denied'
        ? "Notifications are blocked for this site - allow them in the browser's site settings."
        : null;

  return (
    <section className="profile-card mat-panel" aria-labelledby="turn-alerts-title">
      <h2 id="turn-alerts-title" className="profile-section-title">
        Turn alerts
      </h2>
      <p className="profile-hint">How to tell you it's your turn. This browser only.</p>

      <fieldset className="form-group">
        <legend>Sound</legend>
        <div className="profile-choices">
          {SOUND_OPTIONS.map(({ mode, label }) => (
            <label key={mode} className="profile-choice">
              <input
                type="radio"
                name="turnAlertSound"
                value={mode}
                checked={prefs.sound === mode}
                onChange={() => chooseSound(mode)}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="form-group">
        <label className="profile-choice">
          <input
            type="checkbox"
            checked={prefs.desktop && support === 'granted'}
            disabled={support === 'unsupported' || support === 'denied'}
            onChange={(e) => void toggleDesktop(e.target.checked)}
          />
          Desktop notifications when I'm away
        </label>
        {desktopNote && <p className="profile-hint">{desktopNote}</p>}
      </div>
    </section>
  );
}
