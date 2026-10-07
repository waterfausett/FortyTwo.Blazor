// Turns on the first time `trigger` is true, then stays on - whatever `trigger` does - until
// `active` turns off.
import { useEffect, useState } from 'react';

export function useLatch(trigger: boolean, active: boolean): boolean {
  const [latched, setLatched] = useState(false);
  useEffect(() => {
    if (!active) setLatched(false);
    else if (trigger) setLatched(true);
  }, [trigger, active]);
  return active && (latched || trigger);
}
