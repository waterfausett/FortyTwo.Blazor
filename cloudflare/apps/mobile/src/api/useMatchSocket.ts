// React hook over @fortytwo/client's connectMatchSocket, which receives live MatchState updates
// from MatchDO's broadcast socket and retries a dropped connection with exponential backoff. This
// file adds the React state and the app's wake-up signals. It mirrors apps/web's hook of the same
// name, which uses the browser's equivalents.
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { connectMatchSocket } from '@fortytwo/client';
import type { MatchState } from '@fortytwo/rules';
import { config } from '@/config';

// The OS suspends a backgrounded app's sockets, and a dropped network kills them anywhere. When
// the app comes back to the foreground or the network returns, reconnect now rather than sitting
// out the backoff.
function subscribeAppWake(wake: () => void): () => void {
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') wake();
  });
  const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
    if (state.isConnected) wake();
  });
  return () => {
    appState.remove();
    unsubscribeNetInfo();
  };
}

export function useMatchSocket(
  matchId: string,
  getToken: () => Promise<string>
): { match: MatchState | null; connected: boolean; reconnecting: boolean } {
  // Both are tagged with the matchId they belong to, so the very first render for a new matchId
  // never shows the previous match's state (or its "connected") while the new socket comes up.
  const [latest, setLatest] = useState<{ matchId: string; match: MatchState } | null>(null);
  const [connectedTo, setConnectedTo] = useState<string | null>(null);
  // Set when a socket closes on us and cleared when one opens; the initial connect doesn't count.
  const [droppedFrom, setDroppedFrom] = useState<string | null>(null);

  // Kept in a ref so a new getToken closure doesn't tear down the socket; synced after commit.
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  useEffect(() => {
    const disconnect = connectMatchSocket({
      matchId,
      origin: config.wsOrigin,
      getToken: () => getTokenRef.current(),
      onOpen: () => {
        setConnectedTo(matchId);
        setDroppedFrom(null);
      },
      onMatch: (match) => setLatest({ matchId, match }),
      onDrop: () => {
        setConnectedTo(null);
        setDroppedFrom(matchId);
      },
      subscribeWake: subscribeAppWake,
    });

    return () => {
      disconnect();
      setLatest(null);
      setConnectedTo(null);
      setDroppedFrom(null);
    };
  }, [matchId]);

  return {
    match: latest?.matchId === matchId ? latest.match : null,
    connected: connectedTo === matchId,
    reconnecting: droppedFrom === matchId,
  };
}
