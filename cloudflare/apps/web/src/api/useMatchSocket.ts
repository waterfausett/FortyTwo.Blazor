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
): { match: MatchState | null; connected: boolean } {
  const [match, setMatch] = useState<MatchState | null>(null);
  const [connected, setConnected] = useState(false);

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
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

    async function connect() {
      const token = await getTokenRef.current();
      // The effect may have been cleaned up (unmount, or matchId changing) while we were awaiting
      // the token - bail out rather than opening a socket nobody will ever close.
      if (cancelled) return;

      const ws = new WebSocket(`${import.meta.env.VITE_WS_ORIGIN}/matches/${matchId}/ws?token=${token}`);
      socket = ws;

      ws.addEventListener('open', () => {
        if (cancelled) return;
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
        setConnected(true);
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
          setMatch(data.match);
        }
      });

      ws.addEventListener('close', (event: CloseEvent) => {
        socket = null;
        // A cancelled effect means this close came from OUR OWN cleanup below (unmount, or
        // matchId changing) - never reconnect in that case, regardless of the close event's
        // wasClean flag.
        if (cancelled) return;
        setConnected(false);
        // event.wasClean is false for an unexpected drop (network blip, server restart, etc.) -
        // reconnect with exponential backoff. A clean, server-initiated close (wasClean: true)
        // is treated as intentional and is not retried.
        if (!event.wasClean) {
          reconnectTimer = setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
            connect();
          }, reconnectDelay);
        }
      });
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [matchId]);

  return { match, connected };
}
