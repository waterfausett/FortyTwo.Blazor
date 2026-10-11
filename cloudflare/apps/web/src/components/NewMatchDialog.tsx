// The New match chooser: Live and Daily go to matchmaking, Challenge friends sets up a table to
// share (a custom match). Live is left out while bots are off, since it relies on them to fill
// its seats.
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import './NewMatchDialog.css';

export type NewMatchChoice = 'live' | 'daily' | 'challenge';

const OPTIONS: { choice: NewMatchChoice; title: string; detail: string; icon: string }[] = [
  { choice: 'live', title: 'Live', detail: "Play now with whoever's around. Start with bots whenever you like.", icon: '⚡' },
  { choice: 'daily', title: 'Daily', detail: "Take your turns whenever. We'll notify you.", icon: '☀' },
  { choice: 'challenge', title: 'Challenge friends', detail: 'Set up a table and share the invite link.', icon: '✉' },
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
        {OPTIONS.filter((o) => liveEnabled || o.choice !== 'live').map((o) => (
          <button
            key={o.choice}
            type="button"
            className="new-match-option"
            disabled={pending}
            onClick={() => onChoose(o.choice)}
          >
            <span className="new-match-icon" aria-hidden="true">{o.icon}</span>
            <span className="new-match-text">
              <span className="new-match-option-title">{o.title}</span>
              <span className="new-match-option-detail">{o.detail}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
