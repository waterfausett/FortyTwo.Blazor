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
  matchViewFor,
  voteRematch,
  rematchAgreed,
  createRematch,
  assertIsMatchPlayer,
  ValidationError,
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
      const next = typeof body.matchId === 'string' ? { ...created, id: body.matchId } : created;

      await this.save(next);
      this.broadcast(next);
      return next;
    }

    // The other way a match comes into being: the finished match's DO (the `rematch` case below)
    // calls this on the rematch's DO. Returns an existing match untouched, so a retried call can't
    // redeal it.
    if (method === 'createRematch') {
      const stored = await this.load();
      if (stored !== null) {
        // A retry: the first attempt may have failed before its bots were scheduled.
        await this.scheduleBotsIfNeeded(stored);
        return stored;
      }

      const next = createRematch(body.matchId as string, body.previous as MatchState, body.dealOrder as Domino[]);
      await this.save(next);
      this.broadcast(next);
      await this.scheduleBotsIfNeeded(next);
      // No route touches this match on its way in, so the lobby index is synced here, as alarm() does.
      await this.syncLobbyIndex(next);
      return next;
    }

    const existing = await this.load();
    if (existing === null) {
      // Fixes a latent bug in this DO's original sketch: without this check, `existing!` below
      // would be a runtime `null` flowing straight into `matchEngine.ts`, producing an uncaught
      // `TypeError` instead of a clean 404.
      throw new NotFoundError('Match not found!');
    }

    // `getMatch` ports `MatchService.GetAsync` - the full stored match, every hand included. The
    // Worker route never hands it out as-is: it narrows it to the caller's view (matchViewFor).
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
      case 'addBots':
        next = this.addBots(existing, body.requesterId as string, body.positions as number[] | undefined);
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
      case 'rematch':
        next = await this.rematch(existing, body.playerId as string);
        break;
      default:
        throw new NotFoundError('Unknown method');
    }

    await this.save(next);
    this.broadcast(next);
    await this.scheduleBotsIfNeeded(next);
    return next;
  }

  // Seats a bot at each of `positions`, or at every open seat when none are given, so people
  // testing together can fill out the table once everyone who's coming has sat down. Only someone
  // already at the table may do this. Each bot takes the first reserved id not yet seated; a
  // shuffled dealOrder goes with every seat, but takeSeat (matchEngine.ts) only deals on the 4th.
  private addBots(match: MatchState, requesterId: string, positions?: number[]): MatchState {
    assertIsMatchPlayer(match, requesterId);
    const seats =
      positions ?? [0, 1, 2, 3].filter((position) => match.players.every((p) => p.position !== position));

    let next = match;
    for (const position of seats) {
      const botId = BOT_IDS.find((id) => next.players.every((p) => p.playerId !== id))!;
      next = takeSeat(next, botId, position, shuffledDominoOrder());
    }
    return next;
  }

  // Records a rematch vote. The vote that completes the table creates the rematch's DO first, and
  // only then does `rematchId` go on the match - every client follows it (off a broadcast, a
  // reload, or a reconnect), so it must never name a match that doesn't exist yet.
  //
  // The new id is minted once and kept under its own storage key before that call: DO input is
  // only gated on storage, not on an outgoing fetch, so another completing vote can run while it's
  // in flight and must reuse the id rather than mint a second match. If creation fails, this
  // throws before the vote is saved, so the voter's Rematch button stays live and trying again
  // finishes the job against the same (idempotent) id.
  private async rematch(match: MatchState, playerId: string): Promise<MatchState> {
    const next = voteRematch(match, playerId);
    if (next.rematchId !== undefined || rematchAgreed(next).length < next.players.length) return next;

    let rematchId = await this.state.storage.get<string>('pendingRematchId');
    if (rematchId === undefined) {
      rematchId = crypto.randomUUID();
      await this.state.storage.put('pendingRematchId', rematchId);
    }

    const rematchDO = this.env.MATCH_DO.get(this.env.MATCH_DO.idFromName(rematchId));
    const res = await rematchDO.fetch('https://do/rpc/createRematch', {
      method: 'POST',
      body: JSON.stringify({ matchId: rematchId, previous: next, dealOrder: shuffledDominoOrder() }),
    });
    await res.json();
    if (!res.ok) throw new Error(`Creating rematch ${rematchId} failed with ${res.status}`);
    return { ...next, rematchId };
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
    await this.syncLobbyIndex(next);
    await this.scheduleBotsIfNeeded(next);
  }

  // Keeps the D1 lobby index (lobby.ts) in step for changes that don't come through
  // routes/matches.ts, which syncs everything else.
  private async syncLobbyIndex(match: MatchState): Promise<void> {
    await upsertMatchSummary(this.env.DB, {
      id: match.id,
      status: match.winningTeam ? 'completed' : 'active',
      playerCount: match.players.length,
      updatedOn: match.updatedOn,
    });
    await syncMatchPlayers(this.env.DB, match.id, match.players);
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
    //
    // Someone who isn't seated may still connect (the lobby links to matches you haven't joined);
    // they just see every hand hidden, same as the REST route.
    const existing = await this.load();
    if (existing !== null) {
      pair[1].send(matchMessageFor(existing, user.sub));
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

  // Each socket gets its own view - its player's hand, and only a count of everyone else's.
  private broadcast(match: MatchState): void {
    for (const ws of this.state.getWebSockets()) {
      // Every socket is tagged on upgrade; an untagged one sees no hands at all.
      const attachment = ws.deserializeAttachment() as { playerId: string } | null;
      ws.send(matchMessageFor(match, attachment?.playerId ?? ''));
    }
  }
}

function matchMessageFor(match: MatchState, viewerId: string): string {
  return JSON.stringify({ type: 'match', match: matchViewFor(match, viewerId) });
}
