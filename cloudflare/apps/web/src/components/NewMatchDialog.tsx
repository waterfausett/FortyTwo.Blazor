// The New match chooser, in two groups: Find opponents (Live and Daily, which go to matchmaking)
// and Play with friends (Challenge friends sets up a custom table to share). Live is left out
// while bots are off, since it relies on them to fill its seats.
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import './NewMatchDialog.css';

export type NewMatchChoice = 'live' | 'daily' | 'challenge';

interface Option {
  choice: NewMatchChoice;
  title: string;
  detail: string;
  // An open-iconic icon (app.css loads the font).
  icon: string;
}

const GROUPS: { id: string; label: string; icon: string; options: Option[] }[] = [
  {
    id: 'matchmade',
    label: 'Find opponents',
    icon: 'oi-people',
    options: [
      { choice: 'live', title: 'Live', detail: 'Matched with players online now. Start with bots any time.', icon: 'oi-bolt' },
      { choice: 'daily', title: 'Daily', detail: "Matched with other Daily players. Take turns whenever; we'll notify you.", icon: 'oi-sun' },
    ],
  },
  {
    id: 'friends',
    label: 'Play with friends',
    icon: 'oi-envelope-closed',
    options: [
      { choice: 'challenge', title: 'Challenge friends', detail: 'Set up a table and send the invite link.', icon: 'oi-envelope-closed' },
    ],
  },
];

export function NewMatchDialog({
  open,
  liveEnabled,
  online,
  pending,
  onChoose,
  onClose,
}: {
  open: boolean;
  liveEnabled: boolean;
  // Players online (the presence socket), or null until the first count arrives.
  online: number | null;
  pending: boolean;
  onChoose: (choice: NewMatchChoice) => void;
  onClose: () => void;
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);
  if (!open) return null;

  return (
    <div className="new-match-scrim" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-match-title"
        tabIndex={-1}
        className="new-match-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2 id="new-match-title" className="new-match-title">New match</h2>
        {online !== null && <p className="new-match-online">{online} online</p>}
        {GROUPS.map((group) => {
          const options = group.options.filter((o) => liveEnabled || o.choice !== 'live');
          if (options.length === 0) return null;
          const labelId = `new-match-${group.id}`;
          return (
            <section key={group.id} role="group" aria-labelledby={labelId} className="new-match-group">
              <h3 id={labelId} className="new-match-group-label">
                <span className={`oi ${group.icon}`} aria-hidden="true"></span>
                {group.label}
              </h3>
              {options.map((o) => (
                <button
                  key={o.choice}
                  type="button"
                  className="new-match-option"
                  disabled={pending}
                  onClick={() => onChoose(o.choice)}
                >
                  <span className="new-match-icon" aria-hidden="true">
                    <span className={`oi ${o.icon}`}></span>
                  </span>
                  <span className="new-match-text">
                    <span className="new-match-option-title">{o.title}</span>
                    <span className="new-match-option-detail">{o.detail}</span>
                  </span>
                </button>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
