// The Worker's clock, as near as this device can tell. Live clocks count down to deadlines the
// Worker sets by its own clock (@fortytwo/rules' live.ts), so a device whose clock is a few seconds
// off would show every countdown that far off - and two devices would disagree. Each match message
// carries the Worker's time (connectMatchSocket), and the gap is kept here. The message's trip
// across the network is not allowed for: a fraction of a second, well under what a clock shows.
let offsetMs = 0;

export function noteServerTime(serverMs: number, receivedAt = Date.now()): void {
  offsetMs = serverMs - receivedAt;
}

// Now, by the Worker's clock. Until a match message arrives, the device's own.
export function serverNow(): number {
  return Date.now() + offsetMs;
}

export function resetServerClock(): void {
  offsetMs = 0;
}
