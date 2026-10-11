// The online count, from one presence socket (@fortytwo/client's connectPresenceSocket) held while
// the player is signed in and the app is in the foreground - closed in the background, like the
// match socket, so a phone in a pocket doesn't count as online. A context, so every screen shares
// the one socket.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { connectPresenceSocket } from '@fortytwo/client';
import { config } from '@/config';
import { useGetToken } from '@/auth/useGetToken';
import { subscribeNetworkWake, useAppInForeground } from '@/api/useMatchSocket';

const OnlineContext = createContext<number | null>(null);

export function PresenceProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [online, setOnline] = useState<number | null>(null);
  const getToken = useGetToken();
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);
  const foreground = useAppInForeground();

  useEffect(() => {
    if (!enabled || !foreground) {
      // No socket to vouch for the last count: don't show it after sign-out or a spell away.
      setOnline(null);
      return;
    }
    const disconnect = connectPresenceSocket({
      origin: config.wsOrigin,
      getToken: () => getTokenRef.current(),
      onOnline: setOnline,
      subscribeWake: subscribeNetworkWake,
    });
    return () => {
      disconnect();
      setOnline(null);
    };
  }, [enabled, foreground]);

  return <OnlineContext.Provider value={online}>{children}</OnlineContext.Provider>;
}

// Players with the app open, or null until the first count arrives.
export function useOnline(): number | null {
  return useContext(OnlineContext);
}
