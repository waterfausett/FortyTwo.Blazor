// The rules in a dialog over the table, from the scoreboard's "?" - so a player can check a rule
// without leaving their seat. Closes on ×, Escape or the backdrop.
import { useEffect } from 'react';
import type { JSX } from 'react';
import { HowToPlayContent } from './HowToPlayContent';

export function HowToPlayDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="how-to-play-backdrop" onClick={onClose}>
      <div
        className="how-to-play-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="how-to-play-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="how-to-play-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <h2 id="how-to-play-dialog-title" className="how-to-play-dialog-title">
          How to play
        </h2>
        <HowToPlayContent headingLevel={3} />
      </div>
    </div>
  );
}
