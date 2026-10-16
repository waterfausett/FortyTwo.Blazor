// The match's house rules in a dialog over the table, from the scoreboard's rules button. Every
// setting, with the ones that differ from a standard table highlighted. Closes on x, Escape or the backdrop.
import { useEffect } from 'react';
import type { JSX } from 'react';
import { houseRuleRows } from '@fortytwo/client';
import type { HouseRules } from '@fortytwo/rules';

export function HouseRulesDialog({ rules, open, onClose }: {
  rules: Partial<HouseRules> | undefined;
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
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
        className="how-to-play-dialog house-rules-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="house-rules-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="how-to-play-close" aria-label="Close" onClick={onClose}>
          &times;
        </button>
        <h2 id="house-rules-dialog-title" className="how-to-play-dialog-title">
          House rules
        </h2>
        <dl className="house-rules-list">
          {houseRuleRows(rules).map((row) => (
            <div key={row.label} className="house-rules-row">
              <dt>{row.label}</dt>
              <dd className={row.custom ? 'house-rules-custom' : undefined}>
                {row.value}
                {row.custom && <span className="visually-hidden"> (house rule)</span>}
              </dd>
            </div>
          ))}
        </dl>
        <p className="house-rules-note">
          <span className="house-rules-custom">Highlighted</span> settings differ from a standard table
        </p>
      </div>
    </div>
  );
}
