// The Hint button and the hint card under the bid, trump or play controls (practice matches only).
// The card advises; the player still makes the move.
import type { JSX } from 'react';
import { hintHeadline, hintRows } from '@fortytwo/client';
import type { HintController } from '../match/useHint';

export function HintPanel({ hint }: { hint: HintController }): JSX.Element | null {
  if (!hint.available) return null;
  const { state } = hint;
  return (
    <section className="hint-panel" aria-label="Hint">
      {state.status === 'idle' && (
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={hint.ask}>
          Hint
        </button>
      )}
      {state.status === 'loading' && (
        <p className="hint-status" role="status">
          Thinking…
        </p>
      )}
      {state.status === 'error' && (
        <p className="hint-status" role="status">
          {state.message}{' '}
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={hint.ask}>
            Try again
          </button>
        </p>
      )}
      {state.status === 'ready' && (
        <>
          <p className="hint-headline">{hintHeadline(state.hint)}</p>
          <ul className="hint-rows">
            {hintRows(state.hint).map((row) => (
              <li key={row.key} className={row.suggested ? 'hint-row hint-row-suggested' : 'hint-row'}>
                <span>{row.label}</span>
                <span>{row.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
