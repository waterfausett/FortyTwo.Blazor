// Receives live MatchState updates from MatchDO's broadcast socket (apps/worker/src/matchDO.ts -
// every change to a match broadcasts `{ type: 'match', match }` to connected sockets), and the
// `{ type: 'poke', from }` a player gets when someone pokes them on their turn. A dropped
// connection is retried with exponential backoff. Framework-free, so each app wraps it in its own
// hook (apps/web/src/api/useMatchSocket.ts) and supplies its own wake-up signals.
import type { MatchState } from '@fortytwo/rules';

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

// The Worker closes every socket with this when their match is deleted (MatchDO's
// MATCH_DELETED_CLOSE_CODE): the last human left, or it expired.
export const MATCH_DELETED_CLOSE_CODE = 4404;

// Close codes the server sends on purpose to say "don't come back". Every other close - clean or
// not - is retried: a DO restart, a Worker deploy, and webSocketClose echoing a 1000 all close
// cleanly without meaning the match is over.
const NO_RECONNECT_CODES: ReadonlySet<number> = new Set([MATCH_DELETED_CLOSE_CODE]);

interface MatchSocketMessage {
  type: 'match';
  match: MatchState;
}

interface PokeSocketMessage {
  type: 'poke';
  from: string;
}

function isMatchSocketMessage(value: unknown): value is MatchSocketMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'match' &&
    'match' in value
  );
}

function isPokeSocketMessage(value: unknown): value is PokeSocketMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'poke' &&
    typeof (value as { from?: unknown }).from === 'string'
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
  // Someone poked this player: it's their turn and they've sat on it a while. `from` is the poker.
  onPoke?: (from: string) => void;
  // A socket closed on us - a live one dropping, or a connect attempt failing. A retry follows.
  onDrop: () => void;
  // The server deleted the match (the last human left, or it expired). Follows an onDrop; no retry
  // follows, and nothing more will arrive.
  onDeleted?: () => void;
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
  onPoke,
  onDrop,
  onDeleted,
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
    } catch {
      // E.g. offline when the token needs renewing. Treat it like a failed connect attempt and
      // retry, rather than leaving nothing scheduled - which would also make reconnectNow a no-op.
      connecting = false;
      if (cancelled) return;
      onDrop();
      scheduleReconnect();
      return;
    }
    connecting = false;
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
      else if (isPokeSocketMessage(data)) onPoke?.(data.from);
    });

    ws.addEventListener('close', (event: { code: number }) => {
      socket = null;
      // Cancelled means this close came from our own dispose below - never reconnect in that
      // case, regardless of the close event's wasClean flag.
      if (cancelled) return;
      onDrop();
      if (event.code === MATCH_DELETED_CLOSE_CODE) onDeleted?.();
      if (NO_RECONNECT_CODES.has(event.code)) return;
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

  const unsubscribeWake = subscribeWake?.(reconnectNow);
  connect();

  return () => {
    cancelled = true;
    unsubscribeWake?.();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
  };
}
