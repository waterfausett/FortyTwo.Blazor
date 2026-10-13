// The current time by the Worker's clock (@fortytwo/client's serverClock.ts), ticking every
// `intervalMs` while `enabled` - for countdowns and count-ups. Stopped, it costs nothing, so pages
// only run it while a clock is on screen.
import { useEffect, useState } from 'react';
import { serverNow } from '@fortytwo/client';

export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    if (!enabled) return;
    setNow(serverNow());
    const id = setInterval(() => setNow(serverNow()), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}
