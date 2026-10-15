// The house rules a Custom Match's creator picks (NewMatchDialog's second step). Controlled:
// every change goes through setHouseRule, which keeps the combination valid.
import type { JSX } from 'react';
import { MAX_MARKS_TO_WIN, MIN_MARKS_TO_WIN, type HouseRules, type LowRule } from '@fortytwo/rules';
import { setHouseRule } from '@fortytwo/client';

const LOW_OPTIONS: { value: LowRule; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
  { value: 'forcedOnly', label: 'Only when forced' },
];

export function HouseRulesForm({
  rules,
  onChange,
  disabled = false,
}: {
  rules: HouseRules;
  onChange: (rules: HouseRules) => void;
  disabled?: boolean;
}): JSX.Element {
  const change = (patch: Partial<HouseRules>) => onChange(setHouseRule(rules, patch));
  const redeal = rules.allPass === 'redeal';

  return (
    <div className="house-rules">
      <fieldset className="house-rules-field" disabled={disabled}>
        <legend>Low</legend>
        {LOW_OPTIONS.map((o) => (
          <label key={o.value} className="house-rules-choice">
            <input
              type="radio"
              name="low"
              checked={rules.low === o.value}
              disabled={o.value === 'forcedOnly' && redeal}
              onChange={() => change({ low: o.value })}
            />
            {o.label}
          </label>
        ))}
        {redeal && <p className="house-rules-note">Nobody is forced to bid when everyone passing redeals.</p>}
      </fieldset>

      <fieldset className="house-rules-field" disabled={disabled}>
        <legend>Plunge</legend>
        <label className="house-rules-choice">
          <input type="checkbox" checked={rules.plunge} onChange={(e) => change({ plunge: e.target.checked })} />
          Allow Plunge
        </label>
      </fieldset>

      <fieldset className="house-rules-field" disabled={disabled}>
        <legend>When everyone passes</legend>
        <label className="house-rules-choice">
          <input type="radio" name="allPass" checked={!redeal} onChange={() => change({ allPass: 'forceLast' })} />
          Last player must bid
        </label>
        <label className="house-rules-choice">
          <input type="radio" name="allPass" checked={redeal} onChange={() => change({ allPass: 'redeal' })} />
          Redeal
        </label>
      </fieldset>

      <fieldset className="house-rules-field" disabled={disabled}>
        <legend>Marks to win</legend>
        <div className="house-rules-stepper">
          <button
            type="button"
            aria-label="Fewer marks"
            disabled={rules.marksToWin <= MIN_MARKS_TO_WIN}
            onClick={() => change({ marksToWin: rules.marksToWin - 1 })}
          >
            −
          </button>
          <span aria-live="polite">{rules.marksToWin}</span>
          <button
            type="button"
            aria-label="More marks"
            disabled={rules.marksToWin >= MAX_MARKS_TO_WIN}
            onClick={() => change({ marksToWin: rules.marksToWin + 1 })}
          >
            +
          </button>
        </div>
      </fieldset>
    </div>
  );
}
