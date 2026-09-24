// Durable Object holding one match's authoritative state - a thin RPC wrapper over
// `@fortytwo/rules`'s `matchEngine.ts` functions, with storage-backed persistence.
import type { Env } from './index';
import { verifyToken } from './auth/verifyJwt';
import {
  createMatch,
  addPlayer,
  patchPlayerReady,
  placeBid,
  setTrump,
  playDomino,
  getPlayerView,
  ValidationError,
  type MatchState,
  type LoggedInPlayer,
  type Domino,
} from '@fortytwo/rules';

// Thrown when an RPC method (other than `create`) is called against a `MatchDO` instance that
// has never had `create` called on it - i.e. `load()` returns `null` from storage. Kept distinct
// from `ValidationError` so `fetch`'s catch block can map it to a clean 404 (matching the real
// C# `MatchesController.Get`'s `NotFound("Match not found!")` for the analogous case) instead of
// the 400 used for `ValidationError`, or letting a raw `TypeError` (from `matchEngine.ts`
// dereferencing a `null` match) escape as an uncaught 500.
class NotFoundError extends Error {}

export class MatchDO implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env
  ) {}

  private async load(): Promise<MatchState | null> {
    return (await this.state.storage.get<MatchState>('match')) ?? null;
  }

  private async save(match: MatchState): Promise<void> {
    await this.state.storage.put('match', match);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      return this.handleWebSocketUpgrade(request);
    }

    const rpcMatch = url.pathname.match(/^\/rpc\/(\w+)$/);
    if (!rpcMatch) return new Response('Not found', { status: 404 });

    try {
      const body = await request.json<Record<string, unknown>>();
      const result = await this.handleRpc(rpcMatch[1], body);
      return Response.json(result);
    } catch (err) {
      if (err instanceof ValidationError) {
        return Response.json({ title: err.title, detail: err.detail }, { status: 400 });
      }
      if (err instanceof NotFoundError) {
        return Response.json({ title: err.message }, { status: 404 });
      }
      throw err;
    }
  }

  private async handleRpc(method: string, body: Record<string, unknown>): Promise<MatchState | LoggedInPlayer> {
    // `create` is the only method allowed to run against a MatchDO with no stored match yet -
    // every other method needs `existing` to be non-null below.
    if (method === 'create') {
      const next = createMatch(body.firstPlayerId as string);
      await this.save(next);
      this.broadcast(next);
      return next;
    }

    const existing = await this.load();
    if (existing === null) {
      // Fixes a latent bug in this DO's original sketch: without this check, `existing!` below
      // would be a runtime `null` flowing straight into `matchEngine.ts`, producing an uncaught
      // `TypeError` instead of a clean 404.
      throw new NotFoundError('Match not found!');
    }

    // `getMatch` ports `MatchService.GetAsync` - a plain, UNGUARDED full-match fetch. The real
    // C# method has zero validation calls (not even a membership check); this is a pre-existing
    // characteristic of the real app, not something to tighten here.
    if (method === 'getMatch') {
      return existing;
    }

    // `getPlayerView` ports `MatchService.GetPlayerForMatch` - a narrow, per-player DTO, guarded
    // by `IsMatchPlayer` (thrown as `ValidationError` inside `getPlayerView` itself).
    if (method === 'getPlayerView') {
      return getPlayerView(existing, body.playerId as string);
    }

    let next: MatchState;
    switch (method) {
      case 'addPlayer':
        // `dealOrder` is optional and passed through as-is: `matchEngine.ts`'s `addPlayer` deals
        // the first hand iff this is the 4th player joining AND a `dealOrder` was supplied. The
        // caller (a future Worker route, Task 16) is responsible for generating a real shuffled
        // deck; MatchDO's job here is only to not silently drop it.
        next = addPlayer(existing, body.playerId as string, body.team as number, body.dealOrder as Domino[] | undefined);
        break;
      case 'readyUp':
        next = patchPlayerReady(existing, body.playerId as string, body.ready as boolean, body.dealOrder as Domino[]);
        break;
      case 'bid':
        next = placeBid(existing, body.playerId as string, body.bid as number);
        break;
      case 'setTrump':
        next = setTrump(existing, body.playerId as string, body.suit as number);
        break;
      case 'playDomino':
        next = playDomino(existing, body.playerId as string, body.domino as Domino);
        break;
      default:
        throw new NotFoundError('Unknown method');
    }

    await this.save(next);
    this.broadcast(next);
    return next;
  }

  // Uses the Hibernation API (`this.state.acceptWebSocket`, not the plain `WebSocket` `accept()`)
  // so connections survive this DO being evicted from memory between actions - an idle game
  // table isn't billed for wall-clock duration just because a client is still connected.
  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if (!token) return new Response('Missing token', { status: 401 });

    let user;
    try {
      user = await verifyToken(token, this.env);
    } catch {
      return new Response('Invalid token', { status: 401 });
    }

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    // Tag the hibernatable socket with the player id so it can be recovered (via
    // `deserializeAttachment()`) after this DO is evicted and re-instantiated.
    pair[1].serializeAttachment({ playerId: user.sub });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Required by the Hibernation API even though clients don't send messages today - all match
  // actions go through the `/rpc/*` routes above, not over the socket.
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    ws.close(code, reason);
  }

  private broadcast(match: MatchState): void {
    const payload = JSON.stringify({ type: 'match', match });
    for (const ws of this.state.getWebSockets()) {
      ws.send(payload);
    }
  }
}
