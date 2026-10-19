// The Hint button's state for this turn (practice matches only, #76): nothing is asked until the
// player presses it, an answer is kept for the rest of the turn, and a new turn - or an answer
// arriving after the turn has moved on - leaves nothing behind. The asking and the words live in
// @fortytwo/client's hints.ts.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MatchState } from '@fortytwo/rules';
import type { Hint, HintResponse } from '@fortytwo/api-types';
import { canAskForHint, fetchHint, hintErrorMessage, hintTurnKey, isAbort } from '@fortytwo/client';

export type HintState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; hint: Hint }
  | { status: 'error'; message: string };

export interface HintController {
  available: boolean;
  state: HintState;
  ask: () => void;
  // The hint on show, for marking the suggestion in the bid, trump and hand controls.
  hint: Hint | null;
}

const IDLE: HintState = { status: 'idle' };

// `paused`: a pre-play is queued, so the domino will play itself - no hint for this turn.
export function useHint(
  match: MatchState | null,
  myPlayerId: string | undefined,
  hintsEnabled: boolean,
  getHint: () => Promise<HintResponse>,
  paused = false
): HintController {
  const available = !paused && canAskForHint(match, myPlayerId, hintsEnabled);
  const key = match ? hintTurnKey(match) : null;
  const [entry, setEntry] = useState<{ key: string | null; state: HintState }>({ key: null, state: IDLE });
  const abortRef = useRef<AbortController | null>(null);
  const getHintRef = useRef(getHint);
  useEffect(() => {
    getHintRef.current = getHint;
  });

  // Leaving a turn stops whatever was still asking about it.
  useEffect(() => () => abortRef.current?.abort(), [key]);

  const current = entry.key === key ? entry.state : IDLE;
  const state = available ? current : IDLE;

  const ask = useCallback(() => {
    if (key === null || current.status === 'loading' || current.status === 'ready') return;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setEntry({ key, state: { status: 'loading' } });
    fetchHint(() => getHintRef.current(), abort.signal).then(
      (hint) => {
        if (!abort.signal.aborted) setEntry({ key, state: { status: 'ready', hint } });
      },
      (error: unknown) => {
        if (!abort.signal.aborted && !isAbort(error)) setEntry({ key, state: { status: 'error', message: hintErrorMessage(error) } });
      }
    );
  }, [key, current.status]);

  return { available, state, ask, hint: state.status === 'ready' ? state.hint : null };
}
