// React hook over @fortytwo/client's connectMatchSocket, which receives live MatchState updates
// from MatchDO's broadcast socket and retries a dropped connection with exponential backoff. This
// file adds the React state and the browser's wake-up signals.
import { useEffect, useRef, useState } from 'react';
import { connectMatchSocket } from '@fortytwo/client';
import type { MatchState } from '@fortytwo/rules';

// Mobile browsers kill sockets in background tabs, and a dropped network kills them anywhere. When
// the tab comes back or the network returns, reconnect now rather than sitting out the backoff.
function subscribeBrowserWake(wake: () => void): () => void {
  function onVisibilityChange() {
    if (document.visibilityState === 'visible') wake();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', wake);
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('online', wake);
  };
}

export function useMatchSocket(
  matchId: string,
  getToken: () => Promise<string>,
  // Someone poked this player on their turn; `from` is who, and `match` the latest state the socket
  // holds, to check the poke against.
  onPoke?: (from: string, match: MatchState | null) => void
): { match: MatchState | null; connected: boolean; reconnecting: boolean; deleted: boolean } {
  // Both are tagged with the matchId they belong to, so the very first render for a new matchId
  // never shows the previous match's state (or its "connected") while the new socket comes up.
  const [latest, setLatest] = useState<{ matchId: string; match: MatchState } | null>(null);
  const [connectedTo, setConnectedTo] = useState<string | null>(null);
  // Set when a socket closes on us - a live one dropping, or a first connect failing - and cleared
  // when one opens. The initial connect doesn't count, so callers can tell "still coming up" apart
  // from "down, retrying".
  const [droppedFrom, setDroppedFrom] = useState<string | null>(null);
  // Set when the server says this match was deleted - nothing more will ever arrive for it.
  const [deletedId, setDeletedId] = useState<string | null>(null);

  // getToken is commonly a fresh closure every render (e.g. Auth0's getAccessTokenSilently
  // wrapped inline) - stash the latest in a ref so the connection effect below only depends on
  // matchId and doesn't tear down/reconnect the socket every render. Synced via its own effect
  // (rather than a direct `getTokenRef.current = getToken` during render) since mutating a ref
  // during render is a React purity violation - it must happen only after render commits.
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);
  // The same for onPoke.
  const onPokeRef = useRef(onPoke);
  useEffect(() => {
    onPokeRef.current = onPoke;
  }, [onPoke]);

  useEffect(() => {
    const disconnect = connectMatchSocket({
      matchId,
      // Unset (or empty) in production, where the Worker serves the web app, so the socket goes to
      // the same host.
      origin:
        import.meta.env.VITE_WS_ORIGIN ||
        `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`,
      getToken: () => getTokenRef.current(),
      onOpen: () => {
        setConnectedTo(matchId);
        setDroppedFrom(null);
      },
      onMatch: (match) => setLatest({ matchId, match }),
      onPoke: (from, match) => onPokeRef.current?.(from, match),
      onDrop: () => {
        setConnectedTo(null);
        setDroppedFrom(matchId);
      },
      onDeleted: () => setDeletedId(matchId),
      subscribeWake: subscribeBrowserWake,
    });

    return () => {
      disconnect();
      // Dropped too, so navigating A -> B -> A can't bring back A's old state before its new
      // socket delivers.
      setLatest(null);
      setConnectedTo(null);
      setDroppedFrom(null);
      setDeletedId(null);
    };
  }, [matchId]);

  return {
    match: latest?.matchId === matchId ? latest.match : null,
    connected: connectedTo === matchId,
    reconnecting: droppedFrom === matchId,
    deleted: deletedId === matchId,
  };
}
