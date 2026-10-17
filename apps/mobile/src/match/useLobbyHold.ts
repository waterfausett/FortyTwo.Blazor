// Whether to show the Live search lobby: while the search runs, and for a moment after the table
// fills, so the player sees the last seat taken ("Table full") before the deal replaces it. A search
// that ends any other way (Cancel, the match deleted) drops the lobby at once, and a table that was
// already full when the screen opened never shows it.
import { useEffect, useState } from 'react';
import { LOBBY_FULL_HOLD_MS } from '@fortytwo/client';

export function useLobbyHold(searching: boolean, full: boolean): boolean {
  const [wasSearching, setWasSearching] = useState(searching);
  const [holding, setHolding] = useState(false);
  if (wasSearching !== searching) {
    setWasSearching(searching);
    setHolding(!searching && full);
  }

  useEffect(() => {
    if (!holding) return;
    const timer = setTimeout(() => setHolding(false), LOBBY_FULL_HOLD_MS);
    return () => clearTimeout(timer);
  }, [holding]);

  return searching || holding;
}
