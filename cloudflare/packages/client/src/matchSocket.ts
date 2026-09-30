// Receives live MatchState updates from MatchDO's broadcast socket (apps/worker/src/matchDO.ts -
// every change to a match broadcasts `{ type: 'match', match }` to connected sockets). A dropped
// connection is retried with exponential backoff. Framework-free, so each app wraps it in its own
// hook (apps/web/src/api/useMatchSocket.ts) and supplies its own wake-up signals.
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

export interface MatchSocketOptions {
  matchId: string;
  // The Worker's WebSocket origin, e.g. `wss://fortytwo.example.com`.
  origin: string;
  // Called before every connect attempt, so a reconnect always carries a fresh token.
  getToken: () => Promise<string>;
  // A socket opened.
  onOpen: () => void;
  onMatch: (match: MatchState) => void;
  // A socket closed on us - a live one dropping, or a connect attempt failing. A retry follows.
  onDrop: () => void;
  // Registers `wake` to be called when it's worth reconnecting now rather than sitting out the rest
  // of a backoff delay that may have grown to 30s - the app coming back to the foreground, or the
  // network returning. Returns an unsubscribe function.
  subscribeWake?: (wake: () => void) => () => void;
}

// Connects straight away and keeps reconnecting until the returned function is called, which
// closes the socket. No callback fires after that.
export function connectMatchSocket({
  matchId,
  origin,
  getToken,
  onOpen,
  onMatch,
  onDrop,
  subscribeWake,
}: MatchSocketOptions): () => void {
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
      token = await getToken();
    } finally {
      connecting = false;
    }
    // We may have been disposed while awaiting the token - bail out rather than opening a socket
    // nobody will ever close.
    if (cancelled) return;

    const ws = new WebSocket(`${origin}/matches/${matchId}/ws?token=${token}`);
    socket = ws;

    ws.addEventListener('open', () => {
      if (cancelled) return;
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      onOpen();
    });

    ws.addEventListener('message', (event: { data: unknown }) => {
      if (cancelled) return;
      let data: unknown;
      try {
        data = JSON.parse(event.data as string);
      } catch {
        return; // Ignore malformed frames.
      }
      if (isMatchSocketMessage(data)) onMatch(data.match);
    });

    ws.addEventListener('close', (event: { code: number }) => {
      socket = null;
      // Cancelled means this close came from our own dispose below - never reconnect in that
      // case, regardless of the close event's wasClean flag.
      if (cancelled) return;
      onDrop();
      if (NO_RECONNECT_CODES.has(event.code)) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        connect();
      }, reconnectDelay);
    });
  }

  function reconnectNow() {
    if (socket !== null || connecting || reconnectTimer === null) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    connect();
  }

  const unsubscribeWake = subscribeWake?.(reconnectNow);
  connect();

  return () => {
    cancelled = true;
    unsubscribeWake?.();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  };
}
