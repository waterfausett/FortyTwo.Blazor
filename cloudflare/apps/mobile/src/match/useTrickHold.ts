// Keeps a just-completed trick on the table for a moment before it's cleared, so players can see
// what was played instead of it vanishing the instant the last domino lands. The broadcast that
// completes a trick also empties `currentTrick`, so the held trick is worked out during render:
// it's the newest of `game.tricks` until the hold for it runs out.
import { useEffect, useRef, useState } from 'react';
import type { Game, Trick } from '@fortytwo/rules';

export const TRICK_HOLD_MS = 1500;

export function useTrickHold(game: Game | null, holdMs = TRICK_HOLD_MS): Trick | null {
  const [revealedCount, setRevealedCount] = useState(game?.tricks.length ?? 0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gameIdRef = useRef(game?.id ?? null);

  useEffect(() => {
    if (!game) return;
    // A new hand was dealt: drop any hold left over from the previous hand's last trick.
    if (gameIdRef.current !== game.id) {
      gameIdRef.current = game.id;
      if (timerRef.current != null) clearTimeout(timerRef.current);
      timerRef.current = null;
      setRevealedCount(game.tricks.length);
      return;
    }
    if (game.tricks.length > revealedCount && timerRef.current == null) {
      const revealAt = game.tricks.length;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setRevealedCount(revealAt);
      }, holdMs);
    }
  }, [game, revealedCount, holdMs]);

  useEffect(
    () => () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    },
    []
  );

  if (!game || game.id !== gameIdRef.current) return null;
  return game.tricks.length > revealedCount ? game.tricks[game.tricks.length - 1] : null;
}
