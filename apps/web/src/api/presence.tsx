// The online count, from one presence socket (@fortytwo/client's connectPresenceSocket) held
// while the app is signed in - when the Worker has it switched on (GET /api/config's `presence`,
// off by default). A context, so the lobby and the match page share the one socket rather than
// each opening their own as the player moves between them.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { JSX, ReactNode } from 'react';
import { connectPresenceSocket } from '@fortytwo/client';
import { useGetToken } from '../auth/useGetToken';
import { apiClient } from './client';
import { subscribeBrowserWake } from './useMatchSocket';

const OnlineContext = createContext<number | null>(null);

export function PresenceProvider({ children }: { children: ReactNode }): JSX.Element {
  const [online, setOnline] = useState<number | null>(null);
  const getToken = useGetToken();
  // Kept in a ref so a new getToken closure doesn't reopen the socket (as in useMatchSocket).
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);
  const config = useQuery({ queryKey: ['config'], queryFn: () => apiClient(getToken).getConfig(), staleTime: Infinity });
  const enabled = config.data?.presence === true;

  useEffect(() => {
    if (!enabled) return;
    const disconnect = connectPresenceSocket({
      origin:
        import.meta.env.VITE_WS_ORIGIN ||
        `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`,
      getToken: () => getTokenRef.current(),
      onOnline: setOnline,
      subscribeWake: subscribeBrowserWake,
    });
    return () => {
      disconnect();
      // A count from a socket that's gone (signed out, say) would only go stale.
      setOnline(null);
    };
  }, [enabled]);

  return <OnlineContext.Provider value={online}>{children}</OnlineContext.Provider>;
}

// Players with the app open, or null until the first count arrives.
export function useOnline(): number | null {
  return useContext(OnlineContext);
}
