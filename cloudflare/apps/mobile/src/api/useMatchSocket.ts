// React hook over @fortytwo/client's connectMatchSocket, which receives live MatchState updates
// from MatchDO's broadcast socket and retries a dropped connection with exponential backoff. This
// file adds the React state, closing the socket while the app is in the background, and reconnecting
// when the network returns. It mirrors apps/web's hook of the same
// name, which uses the browser's equivalents.
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { connectMatchSocket } from '@fortytwo/client';
import type { MatchState } from '@fortytwo/rules';
import { config } from '@/config';

// A dropped network kills sockets: when it returns, reconnect now rather than sitting out the
// backoff.
function subscribeNetworkWake(wake: () => void): () => void {
  return NetInfo.addEventListener((state) => {
    if (state.isConnected) wake();
  });
}

// Whether the app is in the foreground. In the background the match's socket is closed - the OS
// would suspend it anyway - so the Worker knows the player isn't watching and sends them push
// notifications instead (worker: MatchDO's publish). Coming back opens a fresh one.
function useAppInForeground(): boolean {
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setForeground(state !== 'background'));
    return () => subscription.remove();
  }, []);
  return foreground;
}

export function useMatchSocket(
  matchId: string,
  getToken: () => Promise<string>
): { match: MatchState | null; connected: boolean; reconnecting: boolean; deleted: boolean } {
  // Both are tagged with the matchId they belong to, so the very first render for a new matchId
  // never shows the previous match's state (or its "connected") while the new socket comes up.
  const [latest, setLatest] = useState<{ matchId: string; match: MatchState } | null>(null);
  const [connectedTo, setConnectedTo] = useState<string | null>(null);
  // Set when a socket closes on us and cleared when one opens; the initial connect doesn't count.
  const [droppedFrom, setDroppedFrom] = useState<string | null>(null);
  // Set when the server says this match was deleted - nothing more will ever arrive for it.
  const [deletedId, setDeletedId] = useState<string | null>(null);

  // Kept in a ref so a new getToken closure doesn't tear down the socket; synced after commit.
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  const foreground = useAppInForeground();

  // Keeps the last match state while the app is in the background, so coming back shows it at
  // once while the new socket connects.
  useEffect(() => () => setLatest(null), [matchId]);

  useEffect(() => {
    if (!foreground) return;
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
      onDeleted: () => setDeletedId(matchId),
      subscribeWake: subscribeNetworkWake,
    });

    return () => {
      disconnect();
      setConnectedTo(null);
      setDroppedFrom(null);
    };
  }, [matchId, foreground]);

  return {
    match: latest?.matchId === matchId ? latest.match : null,
    connected: connectedTo === matchId,
    reconnecting: droppedFrom === matchId,
    deleted: deletedId === matchId,
  };
}
