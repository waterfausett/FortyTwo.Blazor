// React hook wrapping the native WebSocket API to receive live MatchState updates from MatchDO's
// broadcast socket (apps/worker/src/matchDO.ts, Task 11 - every RPC mutation broadcasts
// `{ type: 'match', match }` to connected sockets). This replaces the old Blazor app's SignalR
// `HubConnection`.
//
// Reconnect strategy note: the old app's `HubConnectionBuilder` (FortyTwo/Client/Program.cs:56-62)
// never called `.WithAutomaticReconnect()`, so its `Reconnected` event handler in App.razor was
// dead code - there is no real "old reconnect pattern" to port. The exponential-backoff strategy
// below is new, added functionality (an improvement over the original, which never reconnected at
// all), not a port of anything that previously worked.
import { useEffect, useRef, useState } from 'react';
import type { MatchState } from '@fortytwo/rules';

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

// Close codes the server sends on purpose to say "don't come back" (e.g. a future "not a player"
// code). Every other close - clean or not - is retried: a DO restart, a Worker deploy, and
// webSocketClose echoing a 1000 all close cleanly without meaning the match is over.
const NO_RECONNECT_CODES: ReadonlySet<number> = new Set();

interface MatchSocketMessage {
  type: 'match';
  match: MatchState;
}

function isMatchSocketMessage(value: unknown): value is MatchSocketMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'match' &&
    'match' in value
  );
}

export function useMatchSocket(
  matchId: string,
  getToken: () => Promise<string>
): { match: MatchState | null; connected: boolean; reconnecting: boolean } {
  // Both are tagged with the matchId they belong to, so the very first render for a new matchId
  // never shows the previous match's state (or its "connected") while the new socket comes up.
  const [latest, setLatest] = useState<{ matchId: string; match: MatchState } | null>(null);
  const [connectedTo, setConnectedTo] = useState<string | null>(null);
  // Set when a socket closes on us - a live one dropping, or a first connect failing - and cleared
  // when one opens. The initial connect doesn't count, so callers can tell "still coming up" apart
  // from "down, retrying".
  const [droppedFrom, setDroppedFrom] = useState<string | null>(null);

  // getToken is commonly a fresh closure every render (e.g. Auth0's getAccessTokenSilently
  // wrapped inline) - stash the latest in a ref so the connection effect below only depends on
  // matchId and doesn't tear down/reconnect the socket every render. Synced via its own effect
  // (rather than a direct `getTokenRef.current = getToken` during render) since mutating a ref
  // during render is a React purity violation - it must happen only after render commits.
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    // True while awaiting the token, before `socket` exists - so a wake-up can't open a second one.
    let connecting = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

    async function connect() {
      connecting = true;
      let token: string;
      try {
        token = await getTokenRef.current();
      } finally {
        connecting = false;
      }
      // The effect may have been cleaned up (unmount, or matchId changing) while we were awaiting
      // the token - bail out rather than opening a socket nobody will ever close.
      if (cancelled) return;

      const ws = new WebSocket(`${import.meta.env.VITE_WS_ORIGIN}/matches/${matchId}/ws?token=${token}`);
      socket = ws;

      ws.addEventListener('open', () => {
        if (cancelled) return;
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        setConnectedTo(matchId);
        setDroppedFrom(null);
      });

      ws.addEventListener('message', (event: MessageEvent) => {
        if (cancelled) return;
        let data: unknown;
        try {
          data = JSON.parse(event.data as string);
        } catch {
          return; // Ignore malformed frames.
        }
        if (isMatchSocketMessage(data)) {
          setLatest({ matchId, match: data.match });
        }
      });

      ws.addEventListener('close', (event: CloseEvent) => {
        socket = null;
        // A cancelled effect means this close came from OUR OWN cleanup below (unmount, or
        // matchId changing) - never reconnect in that case, regardless of the close event's
        // wasClean flag.
        if (cancelled) return;
        setConnectedTo(null);
        setDroppedFrom(matchId);
        if (NO_RECONNECT_CODES.has(event.code)) return;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
          connect();
        }, reconnectDelay);
      });
    }

    // Mobile browsers kill sockets in background tabs, and a dropped network kills them anywhere.
    // When the tab comes back or the network returns, reconnect now rather than sitting out the
    // rest of a backoff delay that may have grown to 30s.
    function reconnectNow() {
      if (socket !== null || connecting || reconnectTimer === null) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      connect();
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') reconnectNow();
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', reconnectNow);
    connect();

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('online', reconnectNow);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      // Dropped too, so navigating A -> B -> A can't bring back A's old state before its new
      // socket delivers.
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
