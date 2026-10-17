// How a player wants to hear about their turn (match/turnAlerts.ts), set on the Profile page and
// kept per browser (localStorage), like the sweep mode.
//
//   sound   - 'off', 'away' (chime only while the tab is hidden or the window unfocused), or
//             'always'.
//   desktop - a system notification while away. Needs the browser's permission too, which the
//             Profile page asks for when this is switched on.

export const SOUND_MODES = ['off', 'away', 'always'] as const;
export type SoundMode = (typeof SOUND_MODES)[number];

export interface AlertPrefs {
  sound: SoundMode;
  desktop: boolean;
}

export const DEFAULT_ALERT_PREFS: AlertPrefs = { sound: 'away', desktop: false };
const STORAGE_KEY = 'fortytwo.turnAlerts';

function isSoundMode(value: unknown): value is SoundMode {
  return SOUND_MODES.includes(value as SoundMode);
}

export function readAlertPrefs(): AlertPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<AlertPrefs> | null;
    return {
      sound: isSoundMode(stored?.sound) ? stored.sound : DEFAULT_ALERT_PREFS.sound,
      desktop: typeof stored?.desktop === 'boolean' ? stored.desktop : DEFAULT_ALERT_PREFS.desktop,
    };
  } catch {
    // Storage blocked or garbled - the defaults still alert.
    return DEFAULT_ALERT_PREFS;
  }
}

export function writeAlertPrefs(prefs: AlertPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage blocked - the choice just won't stick.
  }
}
