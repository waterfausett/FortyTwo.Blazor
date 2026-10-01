// Durable Object holding one match's authoritative state. Its public methods are called over
// Durable Object RPC (routes/matches.ts, and another MatchDO for a rematch); each one runs a
// `@fortytwo/rules` action, saves the result, and broadcasts it to the match's sockets.
import { DurableObject } from 'cloudflare:workers';
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
  removePlayer,
  hasHumanPlayers,
  assertIsMatchPlayer,
  shuffledDominoOrder,
  ValidationError,
  type Bid,
  type Domino,
  type LoggedInPlayer,
  type MatchState,
  type Suit,
  type Teams,
} from '@fortytwo/rules';
import { syncLobbyIndex } from './lobby';
import { BOT_IDS, decideBid, decideTrump, decideDomino, findNextBotAction, type BotAction } from './bots';

// One tick's worth of "thinking time" before a bot acts, via the DO alarm API - so a client sees
// each bot bid/play arrive as its own WebSocket broadcast instead of the whole rest of the hand
// resolving instantly the moment the human acts.
const BOT_MOVE_DELAY_MS = 600;

// Sent to every socket when its match is deleted, so clients stop reconnecting to it. In the
// 4000-4999 range the WebSocket protocol leaves for applications; the web app's useMatchSocket
// knows it by the same number.
export const MATCH_DELETED_CLOSE_CODE = 4404;

export type LeaveResult = { deleted: true } | { deleted: false; match: MatchState };

// What a match action hands back: its result, or why it was refused - a broken rule (400) or no
// match at this id (404) - in the { title, detail } shape the client shows. Returned rather than
// thrown because an exception crossing RPC keeps only its message, not ValidationError's fields.
export type MatchResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404; error: { title: string; detail?: string } };

export class MatchDO extends DurableObject<Env> {
  private async load(): Promise<MatchState | null> {
    return (await this.ctx.storage.get<MatchState>('match')) ?? null;
  }

  private async save(match: MatchState): Promise<void> {
    await this.ctx.storage.put('match', match);
  }

  // Deletes this match for good: no bot move may fire afterwards, every client is told to stop
  // reconnecting, and storage is wiped so a later call finds no match (404).
  private async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    for (const ws of this.ctx.getWebSockets()) {
      ws.close(MATCH_DELETED_CLOSE_CODE, 'Match deleted');
    }
    await this.ctx.storage.deleteAll();
  }

  // Only the WebSocket upgrade still arrives as a request; everything else is an RPC method below.
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/ws') return this.handleWebSocketUpgrade(request);
    return new Response('Not found', { status: 404 });
  }

  // Stores the new match under `matchId`, the id this DO is addressed by, so every later response
  // and broadcast carries the id clients use to reach it.
  async create(firstPlayerId: string, matchId: string): Promise<MatchState> {
    const match = { ...createMatch(firstPlayerId), id: matchId };
    await this.save(match);
    this.broadcast(match);
    return match;
  }

  // The other way a match comes into being: the finished match's DO (`rematch` below) calls this
  // on the rematch's DO. Returns an existing match untouched, so a retried call can't redeal it.
  async createRematch(matchId: string, previous: MatchState, dealOrder: Domino[]): Promise<MatchState> {
    const stored = await this.load();
    if (stored !== null) {
      // A retry: the first attempt may have failed before its bots were scheduled.
      await this.scheduleBotsIfNeeded(stored);
      return stored;
    }

    const match = createRematch(matchId, previous, dealOrder);
    await this.save(match);
    this.broadcast(match);
    await this.scheduleBotsIfNeeded(match);
    // No route touches this match on its way in, so the lobby index is synced here, as alarm() does.
    await syncLobbyIndex(this.env.DB, match);
    return match;
  }

  // The full stored match, every hand included. Routes narrow it to the caller's view before it
  // leaves the Worker (matchViewFor).
  getMatch(): Promise<MatchResult<MatchState>> {
    return this.read((match) => match);
  }

  getPlayerView(playerId: string): Promise<MatchResult<LoggedInPlayer>> {
    return this.read((match) => getPlayerView(match, playerId));
  }

  // `dealOrder` deals the first hand if this is the 4th player to sit down; callers pass one on
  // every join, since only the engine knows which join that is.
  addPlayer(playerId: string, team: Teams, dealOrder?: Domino[]): Promise<MatchResult<MatchState>> {
    return this.update((match) => addPlayer(match, playerId, team, dealOrder));
  }

  takeSeat(playerId: string, position: number, dealOrder?: Domino[]): Promise<MatchResult<MatchState>> {
    return this.update((match) => takeSeat(match, playerId, position, dealOrder));
  }

  // Takes a player back out of a match that hasn't been dealt. When no human is left the match is
  // deleted outright - that's also how a creator cancels a match nobody joined. The caller drops
  // the lobby rows (routes/matches.ts), as routes already own D1 syncing.
  leave(playerId: string): Promise<MatchResult<LeaveResult>> {
    return this.read(async (match): Promise<LeaveResult> => {
      const next = removePlayer(match, playerId);
      if (!hasHumanPlayers(next)) {
        await this.destroy();
        return { deleted: true };
      }
      await this.save(next);
      this.broadcast(next);
      await this.scheduleBotsIfNeeded(next);
      return { deleted: false, match: next };
    });
  }

  // Seats a bot at each of `positions`, or at every open seat when none are given, so people
  // testing together can fill out the table once everyone who's coming has sat down. Only someone
  // already at the table may do this. Each bot takes the first reserved id not yet seated.
  addBots(requesterId: string, positions?: number[]): Promise<MatchResult<MatchState>> {
    return this.update((match) => {
      assertIsMatchPlayer(match, requesterId);
      const seats =
        positions ?? [0, 1, 2, 3].filter((position) => match.players.every((p) => p.position !== position));

      let next = match;
      for (const position of seats) {
        const botId = BOT_IDS.find((id) => next.players.every((p) => p.playerId !== id))!;
        next = takeSeat(next, botId, position, shuffledDominoOrder());
      }
      return next;
    });
  }

  readyUp(playerId: string, ready: boolean, dealOrder: Domino[]): Promise<MatchResult<MatchState>> {
    return this.update((match) => patchPlayerReady(match, playerId, ready, dealOrder));
  }

  bid(playerId: string, bid: Bid): Promise<MatchResult<MatchState>> {
    return this.update((match) => placeBid(match, playerId, bid));
  }

  setTrump(playerId: string, suit: Suit): Promise<MatchResult<MatchState>> {
    return this.update((match) => setTrump(match, playerId, suit));
  }

  playDomino(playerId: string, domino: Domino): Promise<MatchResult<MatchState>> {
    return this.update((match) => playDomino(match, playerId, domino));
  }

  // Records a rematch vote. The vote that completes the table creates the rematch's DO first, and
  // only then does `rematchId` go on the match - every client follows it (off a broadcast, a
  // reload, or a reconnect), so it must never name a match that doesn't exist yet.
  //
  // The new id is minted once and kept under its own storage key before that call: DO input is
  // only gated on storage, not on an outgoing call, so another completing vote can run while it's
  // in flight and must reuse the id rather than mint a second match. If creation fails, this
  // throws before the vote is saved, so the voter's Rematch button stays live and trying again
  // finishes the job against the same (idempotent) id.
  rematch(playerId: string): Promise<MatchResult<MatchState>> {
    return this.update(async (match) => {
      const next = voteRematch(match, playerId);
      if (next.rematchId !== undefined || rematchAgreed(next).length < next.players.length) return next;

      let rematchId = await this.ctx.storage.get<string>('pendingRematchId');
      if (rematchId === undefined) {
        rematchId = crypto.randomUUID();
        await this.ctx.storage.put('pendingRematchId', rematchId);
      }

      const rematchDO = this.env.MATCH_DO.get(this.env.MATCH_DO.idFromName(rematchId));
      await rematchDO.createRematch(rematchId, next, shuffledDominoOrder());
      return { ...next, rematchId };
    });
  }

  // Runs `action` against the stored match, turning a broken rule into a 400 result. Anything else
  // thrown is a bug, and propagates.
  private async read<T>(action: (match: MatchState) => T | Promise<T>): Promise<MatchResult<T>> {
    const match = await this.load();
    if (match === null) return { ok: false, status: 404, error: { title: 'Match not found!' } };
    try {
      return { ok: true, value: await action(match) };
    } catch (err) {
      if (err instanceof ValidationError) {
        return { ok: false, status: 400, error: { title: err.title, detail: err.detail } };
      }
      throw err;
    }
  }

  // `read`, for an action that changes the match: the result is saved, broadcast, and handed to
  // the bots in case one of them moves next.
  private update(action: (match: MatchState) => MatchState | Promise<MatchState>): Promise<MatchResult<MatchState>> {
    return this.read(async (match) => {
      const next = await action(match);
      await this.save(next);
      this.broadcast(next);
      await this.scheduleBotsIfNeeded(next);
      return next;
    });
  }

  // Performs exactly one bot action - whichever `findNextBotAction` (bots.ts) says is next - via
  // the same rules functions the RPC methods use for real players.
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
      await this.ctx.storage.setAlarm(Date.now() + BOT_MOVE_DELAY_MS);
    }
  }

  // Runs one bot action per firing. Alarm-driven changes never pass through routes/matches.ts,
  // which syncs the D1 lobby index for everything else, so it's synced here.
  async alarm(): Promise<void> {
    const match = await this.load();
    if (match === null) return;

    const action = findNextBotAction(match);
    if (action === null) return;

    const next = this.applyBotAction(match, action);
    await this.save(next);
    this.broadcast(next);
    await syncLobbyIndex(this.env.DB, next);
    await this.scheduleBotsIfNeeded(next);
  }

  // Uses the Hibernation API (`this.ctx.acceptWebSocket`, not the plain `WebSocket` `accept()`)
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
    this.ctx.acceptWebSocket(pair[1]);
    // Tag the hibernatable socket with the player id so it can be recovered (via
    // `deserializeAttachment()`) after this DO is evicted and re-instantiated.
    pair[1].serializeAttachment({ playerId: user.sub });

    // Send the current match straight away rather than waiting for the next broadcast, or a client
    // that connects and then does nothing (the creator waiting for others, anyone reconnecting)
    // would never receive any state. Nothing is sent for a DO that has no match yet.
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
  // actions go through the REST routes, not over the socket.
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
    for (const ws of this.ctx.getWebSockets()) {
      // Every socket is tagged on upgrade; an untagged one sees no hands at all.
      const attachment = ws.deserializeAttachment() as { playerId: string } | null;
      ws.send(matchMessageFor(match, attachment?.playerId ?? ''));
    }
  }
}

function matchMessageFor(match: MatchState, viewerId: string): string {
  return JSON.stringify({ type: 'match', match: matchViewFor(match, viewerId) });
}
