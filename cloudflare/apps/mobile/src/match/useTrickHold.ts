// Keeps a just-completed trick on the table for a moment before it's cleared, so players can see
// what was played instead of it vanishing the instant the last domino lands. For the last part of
// that hold the trick is `sweeping`: it leaves the table toward whoever won it.
//
// The broadcast that completes a trick also empties `currentTrick`, so the held trick is worked
// out during render: it's the newest of `game.tricks` until the hold for it runs out.
import { useEffect, useRef, useState } from 'react';
import type { Game, Trick } from '@fortytwo/rules';

export const TRICK_HOLD_MS = 1500;
export const TRICK_SWEEP_MS = 450;

export interface TrickHold {
  heldTrick: Trick | null;
  sweeping: boolean;
}

export function useTrickHold(game: Game | null, holdMs = TRICK_HOLD_MS, sweepMs = TRICK_SWEEP_MS): TrickHold {
  const [revealedCount, setRevealedCount] = useState(game?.tricks.length ?? 0);
  const [sweeping, setSweeping] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sweepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gameIdRef = useRef(game?.id ?? null);

  function clearTimers() {
    if (holdTimer.current != null) clearTimeout(holdTimer.current);
    if (sweepTimer.current != null) clearTimeout(sweepTimer.current);
    holdTimer.current = null;
    sweepTimer.current = null;
  }

  useEffect(() => {
    if (!game) return;
    // A new hand was dealt: drop any hold left over from the previous hand's last trick.
    if (gameIdRef.current !== game.id) {
      gameIdRef.current = game.id;
      clearTimers();
      setSweeping(false);
      setRevealedCount(game.tricks.length);
      return;
    }
    if (game.tricks.length > revealedCount && holdTimer.current == null) {
      const revealAt = game.tricks.length;
      sweepTimer.current = setTimeout(() => {
        sweepTimer.current = null;
        setSweeping(true);
      }, Math.max(0, holdMs - sweepMs));
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        setSweeping(false);
        setRevealedCount(revealAt);
      }, holdMs);
    }
  }, [game, revealedCount, holdMs, sweepMs]);

  useEffect(() => clearTimers, []);

  if (!game || game.id !== gameIdRef.current) return { heldTrick: null, sweeping: false };
  const heldTrick = game.tricks.length > revealedCount ? game.tricks[game.tricks.length - 1] : null;
  return { heldTrick, sweeping: heldTrick != null && sweeping };
}
