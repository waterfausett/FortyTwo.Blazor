// The New match chooser, in three groups: Find opponents (Live and Async, which go to
// matchmaking), Play with friends (Custom Match sets up a custom table to share) and Practice
// (Play vs bots goes straight into a game against three bots). Live and Play vs bots are left out
// while bots are off, since they rely on them to fill their seats. Custom Match first asks for its
// house rules.
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { DEFAULT_HOUSE_RULES, type HouseRules } from '@fortytwo/rules';
import { HouseRulesForm } from './HouseRulesForm';
import './NewMatchDialog.css';

export type NewMatchChoice = 'live' | 'daily' | 'challenge' | 'bots';

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
      { choice: 'live', title: 'Live Play',
        detail: "60-second turns; kicked if away for a full hand.", icon: 'oi-pulse' },
      { choice: 'daily', title: 'Async', detail: "Take turns whenever; we'll notify you.", icon: 'oi-bell' },
    ],
  },
  {
    id: 'friends',
    label: 'Play with friends',
    icon: 'oi-envelope-closed',
    options: [
      { choice: 'challenge', title: 'Custom Match', detail: 'Set up a table and send the invite link.', icon: 'oi-wrench' },
    ],
  },
  {
    id: 'practice',
    label: 'Practice',
    icon: 'oi-laptop',
    options: [
      { choice: 'bots', title: 'Play vs bots', detail: 'Jump straight in against three bots.', icon: 'oi-media-play' },
    ],
  },
];

// How long a choice works before its line admits it's taking a while.
export const SLOW_MS = 3000;

function workingDetail(choice: NewMatchChoice, slow: boolean): string {
  if (slow) return 'Still working - your connection may be slow.';
  return choice === 'challenge' || choice === 'bots' ? 'Setting up the table…' : 'Finding a seat…';
}

// True once `pending` has stayed set for SLOW_MS; false again when it clears.
function useSlow(pending: NewMatchChoice | null): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [pending]);
  return slow;
}

// The dialog's body is only mounted while open, so its step and rules start fresh on each open.
export function NewMatchDialog({ open, ...props }: DialogProps & { open: boolean }): JSX.Element | null {
  return open ? <OpenDialog {...props} /> : null;
}

interface DialogProps {
  liveEnabled: boolean;
  // Players online (the presence socket), or null until the first count arrives.
  online: number | null;
  // The choice being started, or null. Only that option shows it's working; the dialog stays open
  // until it lands, so the player isn't moved to a match after giving up on it.
  pending: NewMatchChoice | null;
  // Why the last choice failed, shown in the dialog rather than on the page behind it.
  error: string | null;
  onChoose: (choice: NewMatchChoice, rules?: HouseRules) => void;
  onClose: () => void;
}

function OpenDialog({
  liveEnabled,
  online,
  pending,
  error,
  onChoose,
  onClose,
}: DialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  const slow = useSlow(pending);
  const close = pending ? () => {} : onClose;
  const [step, setStep] = useState<'choose' | 'rules'>('choose');
  const [rules, setRules] = useState<HouseRules>(DEFAULT_HOUSE_RULES);
  // On open, and when the step changes (the button that had focus unmounts), so Escape keeps working.
  useEffect(() => {
    dialogRef.current?.focus();
  }, [step]);

  return (
    <div className="new-match-scrim" onClick={close}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-match-title"
        tabIndex={-1}
        className="new-match-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      >
        <h2 id="new-match-title" className="new-match-title">New match</h2>
        {online !== null && <p className="new-match-online">{online} online</p>}
        {error && !pending && (
          <p role="alert" className="new-match-error">
            {error}
          </p>
        )}
        {step === 'rules' ? (
          <section className="new-match-rules" aria-labelledby="new-match-rules-title">
            <h3 id="new-match-rules-title" className="new-match-group-label">House rules</h3>
            <HouseRulesForm rules={rules} onChange={setRules} disabled={pending !== null} />
            <div className="new-match-rules-actions">
              <button type="button" className="new-match-back" disabled={pending !== null} onClick={() => setStep('choose')}>
                Back
              </button>
              <button
                type="button"
                className={`new-match-create${pending === 'challenge' ? ' is-working' : ''}`}
                disabled={pending !== null}
                aria-busy={pending === 'challenge'}
                onClick={() => onChoose('challenge', rules)}
              >
                {pending === 'challenge' ? workingDetail('challenge', slow) : 'Create table'}
              </button>
            </div>
          </section>
        ) : (
          GROUPS.map((group) => {
          const options = group.options.filter((o) => liveEnabled || (o.choice !== 'live' && o.choice !== 'bots'));
          if (options.length === 0) return null;
          const labelId = `new-match-${group.id}`;
          return (
            <section key={group.id} role="group" aria-labelledby={labelId} className="new-match-group">
              <h3 id={labelId} className="new-match-group-label">
                <span className={`oi ${group.icon}`} aria-hidden="true"></span>
                {group.label}
              </h3>
              {options.map((o) => {
                const working = pending === o.choice;
                return (
                  <button
                    key={o.choice}
                    type="button"
                    className={`new-match-option${working ? ' is-working' : ''}`}
                    disabled={pending !== null}
                    aria-busy={working}
                    onClick={() => (o.choice === 'challenge' ? setStep('rules') : onChoose(o.choice))}
                  >
                    <span className="new-match-icon" aria-hidden="true">
                      <span className={working ? 'oi oi-loop-circular spinner' : `oi ${o.icon}`}></span>
                    </span>
                    <span className="new-match-text">
                      <span className="new-match-option-title">{o.title}</span>
                      <span className="new-match-option-detail">{working ? workingDetail(o.choice, slow) : o.detail}</span>
                    </span>
                  </button>
                );
              })}
            </section>
          );
          })
        )}
      </div>
    </div>
  );
}
