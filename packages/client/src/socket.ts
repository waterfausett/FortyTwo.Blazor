// One server socket kept open: a fresh token on every connect, exponential backoff (1 s doubling to
// 30 s) after a drop, and an immediate retry on a wake-up. Shared by the match socket
// (matchSocket.ts) and the presence socket (presenceSocket.ts), which add their own messages.
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

export interface SocketOptions {
  // The full URL to open, given a fresh token.
  url: (token: string) => string;
  getToken: () => Promise<string>;
  onOpen?: () => void;
  // Each parsed JSON frame; malformed ones are dropped before this.
  onMessage: (data: unknown) => void;
  // A socket closed on us. A retry follows unless the close code is in `finalCodes`.
  onDrop?: (code: number) => void;
  // Close codes meaning "don't come back".
  finalCodes?: ReadonlySet<number>;
  subscribeWake?: (wake: () => void) => () => void;
}

// Connects straight away and keeps reconnecting until the returned function is called, which
// closes the socket. No callback fires after that.
export function connectSocket(options: SocketOptions): () => void {
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
      token = await options.getToken();
    } catch {
      // E.g. offline when the token needs renewing. Treat it like a failed connect attempt and
      // retry, rather than leaving nothing scheduled - which would also make reconnectNow a no-op.
      connecting = false;
      if (cancelled) return;
      options.onDrop?.(0);
      scheduleReconnect();
      return;
    }
    connecting = false;
    // We may have been disposed while awaiting the token - bail out rather than opening a socket
    // nobody will ever close.
    if (cancelled) return;

    const ws = new WebSocket(options.url(token));
    socket = ws;

    ws.addEventListener('open', () => {
      if (cancelled) return;
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      options.onOpen?.();
    });

    ws.addEventListener('message', (event: { data: unknown }) => {
      if (cancelled) return;
      let data: unknown;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return; // Ignore malformed frames.
      }
      options.onMessage(data);
    });

    ws.addEventListener('close', (event: { code: number }) => {
      socket = null;
      // Cancelled means this close came from our own dispose below - never reconnect in that
      // case, regardless of the close event's wasClean flag.
      if (cancelled) return;
      options.onDrop?.(event.code);
      if (options.finalCodes?.has(event.code)) return;
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    // Only one of a pending timer, a token fetch, or a socket exists at a time, so this should
    // never find a timer already set - but if it does, don't leak it into a second connect.
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      connect();
    }, reconnectDelay);
  }

  function reconnectNow() {
    if (socket !== null || connecting || reconnectTimer === null) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    connect();
  }

  const unsubscribeWake = options.subscribeWake?.(reconnectNow);
  connect();

  return () => {
    cancelled = true;
    unsubscribeWake?.();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  };
}
