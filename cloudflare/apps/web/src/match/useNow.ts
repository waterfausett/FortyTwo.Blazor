// The current time, ticking every `intervalMs` while `enabled` - for countdowns and count-ups.
// Stopped, it costs nothing, so pages only run it while a clock is on screen.
import { useEffect, useState } from 'react';

export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}
