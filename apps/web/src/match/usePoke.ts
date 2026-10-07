// The Poke button's state: who it would poke, once the turn has waited long enough
// (@fortytwo/client's poke.ts), and the request itself. The Worker makes the final call; this only
// decides when the button is worth showing. It hides once this turn has been poked from here.
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { pokeTarget, pokeTurnKey, pokeableAt, type PokeResult } from '@fortytwo/client';
import type { MatchState } from '@fortytwo/rules';
import { toastError, toastInfo } from '../ui/toast';

export function usePoke(
  match: MatchState | null,
  myPlayerId: string | undefined,
  poke: () => Promise<PokeResult>,
  nameOf: (playerId: string) => string | null
): { target: string | null; poke: () => void; pending: boolean } {
  const target = pokeTarget(match, myPlayerId);
  const turn = match && target ? pokeTurnKey(match) : null;
  const readyAt = match && target ? pokeableAt(match) : null;

  // The turn whose wait has run out, set by a timer so the button appears without anything else
  // changing on the page; and the turn poked from here, which hides it again.
  const [idleTurn, setIdleTurn] = useState<string | null>(null);
  const [pokedTurn, setPokedTurn] = useState<string | null>(null);
  useEffect(() => {
    if (turn == null || readyAt == null) return;
    const timer = setTimeout(() => setIdleTurn(turn), Math.max(0, readyAt - Date.now()));
    return () => clearTimeout(timer);
  }, [turn, readyAt]);

  const mutation = useMutation({
    mutationFn: (_poked: { target: string; turn: string }) => poke(),
    onSuccess: ({ delivered }, poked) => {
      const name = nameOf(poked.target);
      // A poke that reached nobody leaves the turn's poke unused, so the button stays.
      if (delivered === 'none') {
        toastInfo(name ? `${name} doesn't have notifications on` : "They don't have notifications on");
        return;
      }
      setPokedTurn(poked.turn);
      toastInfo(name ? `Poked ${name}` : 'Poked');
    },
    onError: toastError,
  });

  // Held back until the target's name has loaded, so the button never reads "Poke auth0|...".
  const showing =
    target != null && turn != null && idleTurn === turn && pokedTurn !== turn && nameOf(target) != null;
  return {
    target: showing ? target : null,
    poke: () => {
      if (target != null && turn != null) mutation.mutate({ target, turn });
    },
    pending: mutation.isPending,
  };
}
