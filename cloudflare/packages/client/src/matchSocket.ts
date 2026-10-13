// Receives live MatchState updates from MatchDO's broadcast socket (apps/worker/src/matchDO.ts -
// every change to a match broadcasts `{ type: 'match', match, now }` to connected sockets), and the
// `{ type: 'poke', from }` a player gets when someone pokes them on their turn. A dropped
// connection is retried with exponential backoff. Framework-free, so each app wraps it in its own
// hook (apps/web/src/api/useMatchSocket.ts) and supplies its own wake-up signals.
import type { MatchState } from '@fortytwo/rules';
import { noteServerTime } from './serverClock';
import { connectSocket } from './socket';

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
  // The Worker's clock when it sent this (serverClock.ts). Absent from a Worker older than it.
  now?: number;
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
export function connectMatchSocket({ matchId, origin, getToken, onOpen, onMatch, onPoke, onDrop, onDeleted, subscribeWake }: MatchSocketOptions): () => void {
  return connectSocket({
    url: (token) => `${origin}/matches/${matchId}/ws?token=${token}`,
    getToken,
    onOpen,
    onMessage: (data) => {
      if (isMatchSocketMessage(data)) {
        if (typeof data.now === 'number') noteServerTime(data.now);
        onMatch(data.match);
      }
      else if (isPokeSocketMessage(data)) onPoke?.(data.from);
    },
    onDrop: (code) => {
      onDrop();
      if (code === MATCH_DELETED_CLOSE_CODE) onDeleted?.();
    },
    finalCodes: NO_RECONNECT_CODES,
    subscribeWake,
  });
}
