// Hints in practice matches. The Hint button sits beside the bid or trump prompt (or the play
// status line); once answered, a bid or trump hint names its suggestion there and a play hint just
// rings the domino in the hand. The details card - chances to make and the close alternatives -
// shows only with ClientConfig.hintDetails on. A hint advises; the player still makes the move.
import type { JSX } from 'react';
import { hintHeadline, hintRows, hintSuggestion } from '@fortytwo/client';
import type { HintController } from '../match/useHint';

// Every state is the same height (match.css's .hint-slot), so the prompt beside it doesn't move
// when the button gives way to "Thinking…" and then the answer.
export function HintButton({ hint }: { hint: HintController }): JSX.Element | null {
  if (!hint.available) return null;
  const { state } = hint;
  switch (state.status) {
    case 'idle':
      return (
        <button type="button" className="hint-slot hint-button" onClick={hint.ask}>
          Hint
        </button>
      );
    case 'loading':
      return (
        <span className="hint-slot hint-status" role="status">
          Thinking…
        </span>
      );
    case 'error':
      return (
        <span className="hint-slot hint-status" role="status">
          {state.message}
          <button type="button" className="hint-slot hint-button" onClick={hint.ask}>
            Try again
          </button>
        </span>
      );
    case 'ready':
      // The ringed domino is the whole of a play hint.
      return state.hint.kind === 'play' ? null : (
        <span className="hint-slot hint-suggestion" role="status">
          {hintSuggestion(state.hint)}
        </span>
      );
  }
}

export function HintDetails({ hint, show }: { hint: HintController; show: boolean }): JSX.Element | null {
  if (!show || !hint.available || hint.state.status !== 'ready') return null;
  const answer = hint.state.hint;
  return (
    <section className="hint-panel" aria-label="Hint details">
      <p className="hint-headline">{hintHeadline(answer)}</p>
      <ul className="hint-rows">
        {hintRows(answer).map((row) => (
          <li key={row.key} className={row.suggested ? 'hint-row hint-row-suggested' : 'hint-row'}>
            <span>{row.label}</span>
            <span>{row.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
