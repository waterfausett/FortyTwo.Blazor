// Whether `active` has been on for `ms`: false the moment it turns on, true once that long has
// passed, and false again as soon as it turns off. On from the start counts as settled, so a
// screen opened mid-phase shows everything at once.
import { useEffect, useState } from 'react';

export function useSettled(active: boolean, ms: number): boolean {
  const [settled, setSettled] = useState(active);
  useEffect(() => {
    if (!active) {
      setSettled(false);
      return;
    }
    if (settled) return;
    const timer = setTimeout(() => setSettled(true), ms);
    return () => clearTimeout(timer);
  }, [active, settled, ms]);
  return active && settled;
}
