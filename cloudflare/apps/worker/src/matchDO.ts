// Durable Object holding one match's authoritative state - a thin RPC wrapper over
// `@fortytwo/rules`'s `matchEngine.ts` functions, with storage-backed persistence.
import type { Env } from './index';
import { verifyToken } from './auth/verifyJwt';
import {
  createMatch,
  addPlayer,
  takeSeat,
  patchPlayerReady,
  placeBid,
  setTrump,
  playDomino,
  getPlayerView,
  ValidationError,
  Teams,
  type MatchState,
  type LoggedInPlayer,
  type Domino,
} from '@fortytwo/rules';
import { upsertMatchSummary, syncMatchPlayers } from './lobby';
import { BOT_IDS, shuffledDominoOrder, decideBid, decideTrump, decideDomino, findNextBotAction, type BotAction } from './bots';

// One tick's worth of "thinking time" before a bot acts, via the DO alarm API - so a client sees
// each bot bid/play arrive as its own WebSocket broadcast instead of the whole rest of the hand
// resolving instantly the moment the human acts.
const BOT_MOVE_DELAY_MS = 600;

// TeamA/TeamB alternation that, combined with addPlayer's (matchEngine.ts) own position-assignment
// rules, seats the 3 bots evenly opposite and alongside the human: bot-1 joins the human's
// opponents (TeamB), bot-2 joins the human's own team (TeamA), bot-3 fills the last TeamB seat.
const BOT_TEAMS: Teams[] = [Teams.TeamB, Teams.TeamA, Teams.TeamB];

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
      // `createMatch()` mints its own internal `id` via `crypto.randomUUID()`, independent of
      // this DO instance's own address (the `matchId` the Worker route used to reach this stub
      // via `idFromName`). When the caller supplies that same `matchId` here, override the
      // stored match's id with it right at creation - `matchEngine.ts`'s other functions all
      // take an existing `match` and preserve `.id` unchanged, so fixing it once here means
      // every later read, RPC response, AND `broadcast()` payload naturally carries the correct
      // id forever after, with no per-call patching needed anywhere else (REST or WebSocket).
      const created = createMatch(body.firstPlayerId as string);
      let next = typeof body.matchId === 'string' ? { ...created, id: body.matchId } : created;

      if (this.env.AUTO_PLAY_BOTS === 'true') {
        next = this.seedBots(next);
      }

      await this.save(next);
      this.broadcast(next);
      await this.scheduleBotsIfNeeded(next);
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
      case 'takeSeat':
        // Same as addPlayer, but at a seat the joining player picked rather than one derived from
        // a team.
        next = takeSeat(existing, body.playerId as string, body.position as number, body.dealOrder as Domino[] | undefined);
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
    await this.scheduleBotsIfNeeded(next);
    return next;
  }

  // Adds the 3 reserved bot ids right after the human creates a match, so AUTO_PLAY_BOTS goes
  // straight from "create" to a full table with no lobby wait. Mirrors what a real 4th join does
  // (matches.ts's shuffledDominoOrder()) - the dealOrder only matters on the last add, exactly as
  // addPlayer (matchEngine.ts) itself only deals once the 4th hand joins.
  private seedBots(match: MatchState): MatchState {
    let next = match;
    for (let i = 0; i < BOT_IDS.length; i++) {
      const isLastSeat = i === BOT_IDS.length - 1;
      next = addPlayer(next, BOT_IDS[i], BOT_TEAMS[i], isLastSeat ? shuffledDominoOrder() : undefined);
    }
    return next;
  }

  // Performs exactly one bot action - whichever `findNextBotAction` (bots.ts) says is next - via
  // the same matchEngine functions `handleRpc` uses for real players.
  private applyBotAction(match: MatchState, action: BotAction): MatchState {
    const hand = match.currentGame.hands.find((h) => h.playerId === action.playerId)!;
    switch (action.kind) {
      case 'ready':
        return patchPlayerReady(match, action.playerId, true, shuffledDominoOrder());
      case 'bid':
        return placeBid(match, action.playerId, decideBid(match.currentGame, hand));
      case 'setTrump':
        return setTrump(match, action.playerId, decideTrump(hand));
      case 'play':
        return playDomino(match, action.playerId, decideDomino(match.currentGame, hand));
    }
  }

  // Schedules the next bot action a beat in the future (via the alarm API) if one is pending,
  // rather than resolving it inline - each bot move then arrives as its own broadcast, matching
  // the pacing a real remote player's move would have.
  private async scheduleBotsIfNeeded(match: MatchState): Promise<void> {
    if (findNextBotAction(match) !== null) {
      await this.state.storage.setAlarm(Date.now() + BOT_MOVE_DELAY_MS);
    }
  }

  // Runs one bot action per firing, syncing the D1 lobby index (lobby.ts) the same way
  // routes/matches.ts does for human-driven REST calls - alarm-driven mutations never pass through
  // those routes, so MatchDO must keep that index in sync itself here.
  async alarm(): Promise<void> {
    const match = await this.load();
    if (match === null) return;

    const action = findNextBotAction(match);
    if (action === null) return;

    const next = this.applyBotAction(match, action);
    await this.save(next);
    this.broadcast(next);
    await upsertMatchSummary(this.env.DB, {
      id: next.id,
      status: next.winningTeam ? 'completed' : 'active',
      playerCount: next.players.length,
      updatedOn: next.updatedOn,
    });
    await syncMatchPlayers(this.env.DB, next.id, next.players);
    await this.scheduleBotsIfNeeded(next);
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

    // Send the CURRENT match state to the newly-connected socket immediately, rather than making
    // it wait for the next `broadcast()` from a future RPC mutation - otherwise a client that
    // connects and then does nothing (e.g. the match creator waiting for others to join, or anyone
    // reconnecting mid-game) never receives any state at all. `existing` may be null only if a
    // client somehow opens a socket against a DO that was never `create`d - nothing to send yet in
    // that case, so this is skipped rather than sending a `null` match.
    const existing = await this.load();
    if (existing !== null) {
      pair[1].send(JSON.stringify({ type: 'match', match: existing }));
    }

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Required by the Hibernation API even though clients don't send messages today - all match
  // actions go through the `/rpc/*` routes above, not over the socket.
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // Only 1000 and the custom 3000-4999 range may be passed explicitly to `close()` - the rest
    // (1001-1015) are reserved by the WebSocket protocol. A client that disconnects without
    // sending a close frame (e.g. a tab navigating away) reports 1005 ("No Status Received"),
    // which throws `InvalidAccessError` if forwarded as-is.
    if (code === 1000 || (code >= 3000 && code <= 4999)) {
      ws.close(code, reason);
    } else {
      ws.close();
    }
  }

  private broadcast(match: MatchState): void {
    const payload = JSON.stringify({ type: 'match', match });
    for (const ws of this.state.getWebSockets()) {
      ws.send(payload);
    }
  }
}
