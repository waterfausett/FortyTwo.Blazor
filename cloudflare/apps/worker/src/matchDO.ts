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
import { bestEffort, syncLobbyIndex, refreshMatchSummary } from './lobby';
import { pushNotices } from './push/notices';
import { sendNotices } from './push/send';
import { tokensFor } from './push/tokens';
import { pokeNotice, pokeTarget, pokeTurnKey } from './poke';
import type { PokeResult } from '@fortytwo/api-types';
import { BOT_IDS, applyBotAction, botDelayMs, botsEnabled, findNextBotAction } from './bots';
import { WARMING, getMlBot } from './mlBot';

// While the ML bot loads and warms up in a fresh isolate, each piece gets its own alarm, this far
// apart (see alarm()).
const BOT_WARM_UP_TICK_MS = 100;

// Sent to every socket when its match is deleted, so clients stop reconnecting to it. In the
// 4000-4999 range the WebSocket protocol leaves for applications; the web app's useMatchSocket
// knows it by the same number.
export const MATCH_DELETED_CLOSE_CODE = 4404;

export type LeaveResult = { deleted: true } | { deleted: false; match: MatchState };

// What the expiry sweep (expiry.ts) learns from one match: it was deleted, the lobby row that
// pointed here was stale (here's the match to re-sync it from), or there was nothing here at all.
export type ExpireOutcome = { outcome: 'expired' } | { outcome: 'missing' } | { outcome: 'fresh'; match: MatchState };

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
    this.publish(null, match);
    return match;
  }

  // The other way a match comes into being: the finished match's DO (`rematch` below) calls this
  // on the rematch's DO. Returns an existing match untouched, so a retried call can't redeal it.
  // No route touches this match on its way in, so the lobby index is synced here, as alarm() does.
  // `onTheWay` are the players on the finished match's screen - the one whose vote completed the
  // agreement, and anyone else with it open - which takes them straight here. No socket of theirs
  // is open on this match yet, so they're named to count as watching it, and aren't pushed.
  async createRematch(
    matchId: string,
    previous: MatchState,
    dealOrder: Domino[],
    onTheWay: string[] = []
  ): Promise<MatchState> {
    const stored = await this.load();
    if (stored !== null) {
      // A retry: the first attempt may have failed before its bots were scheduled or its lobby
      // rows were written.
      await this.scheduleBotsIfNeeded(stored);
      await bestEffort(matchId, () => syncLobbyIndex(this.env.DB, stored));
      return stored;
    }

    const match = createRematch(matchId, previous, dealOrder);
    await this.save(match);
    this.publish(null, match, onTheWay);
    await this.scheduleBotsIfNeeded(match);
    await bestEffort(matchId, () => syncLobbyIndex(this.env.DB, match));
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
    return this.update(playerId, (match) => addPlayer(match, playerId, team, dealOrder));
  }

  takeSeat(playerId: string, position: number, dealOrder?: Domino[]): Promise<MatchResult<MatchState>> {
    return this.update(playerId, (match) => takeSeat(match, playerId, position, dealOrder));
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

  // Deletes this match if it is still active and was last changed before `cutoff`. This DO, not
  // the D1 row that led the sweep here, decides - the row is only an index and can lag behind.
  async expire(cutoff: string): Promise<ExpireOutcome> {
    const match = await this.load();
    if (match === null) return { outcome: 'missing' };
    if (match.winningTeam !== null || match.updatedOn >= cutoff) return { outcome: 'fresh', match };
    await this.destroy();
    return { outcome: 'expired' };
  }

  // Seats a bot at each of `positions`, or at every open seat when none are given, so people
  // testing together can fill out the table once everyone who's coming has sat down. Only someone
  // already at the table may do this. Each bot takes the first reserved id not yet seated.
  addBots(requesterId: string, positions?: number[]): Promise<MatchResult<MatchState>> {
    return this.update(requesterId, (match) => {
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
    return this.update(playerId, (match) => patchPlayerReady(match, playerId, ready, dealOrder));
  }

  bid(playerId: string, bid: Bid): Promise<MatchResult<MatchState>> {
    return this.update(playerId, (match) => placeBid(match, playerId, bid));
  }

  setTrump(playerId: string, suit: Suit): Promise<MatchResult<MatchState>> {
    return this.update(playerId, (match) => setTrump(match, playerId, suit));
  }

  playDomino(playerId: string, domino: Domino): Promise<MatchResult<MatchState>> {
    return this.update(playerId, (match) => playDomino(match, playerId, domino));
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
    return this.update(playerId, async (match) => {
      const next = voteRematch(match, playerId);
      if (next.rematchId !== undefined || rematchAgreed(next).length < next.players.length) return next;

      let rematchId = await this.ctx.storage.get<string>('pendingRematchId');
      if (rematchId === undefined) {
        rematchId = crypto.randomUUID();
        await this.ctx.storage.put('pendingRematchId', rematchId);
      }

      const rematchDO = this.env.MATCH_DO.get(this.env.MATCH_DO.idFromName(rematchId));
      const onTheWay = [...new Set([playerId, ...this.watchingPlayers()])];
      await rematchDO.createRematch(rematchId, next, shuffledDominoOrder(), onTheWay);
      return { ...next, rematchId };
    });
  }

  // Nudges the player whose turn it is once they've sat on it a while (poke.ts): over their socket
  // if they have the match open, else as a push notification. One poke per turn, whoever sends it,
  // recorded under its own key naming the turn - so the next turn can be poked again without the
  // match itself changing. A poke that reaches nobody (no socket open, no device registered)
  // doesn't use the turn's poke up, and the reply says so, so the poker isn't left guessing. It
  // writes nothing either, so trying it again and again costs reads, never writes.
  poke(pokerId: string): Promise<MatchResult<PokeResult>> {
    return this.read(async (match): Promise<PokeResult> => {
      const target = pokeTarget(match, pokerId, Date.now());
      const turn = pokeTurnKey(match);
      await this.assertNotPoked(turn);

      const sockets = this.socketsOf(target);
      if (sockets.length > 0) {
        await this.ctx.storage.put('pokedTurn', turn);
        const message = JSON.stringify({ type: 'poke', from: pokerId });
        for (const ws of sockets) ws.send(message);
        return { delivered: 'inApp' };
      }
      if ((await tokensFor(this.env.DB, [target])).length === 0) return { delivered: 'none' };

      // The D1 lookup let other calls in while it was out: the turn may have moved on, or been
      // poked by someone else. Storage calls alone don't, so checking and claiming below is safe.
      const current = await this.load();
      if (current === null || pokeTurnKey(current) !== turn) {
        throw new ValidationError('Too late to poke', "It's no longer their turn.");
      }
      await this.assertNotPoked(turn);
      await this.ctx.storage.put('pokedTurn', turn);
      this.ctx.waitUntil(sendNotices(this.env, [pokeNotice(match, target)]));
      return { delivered: 'push' };
    });
  }

  // Refuses a poke for a turn that's already been poked.
  private async assertNotPoked(turn: string): Promise<void> {
    if ((await this.ctx.storage.get<string>('pokedTurn')) === turn) {
      throw new ValidationError('Already poked', 'Someone has already poked them this turn.');
    }
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
  // the bots in case one of them moves next. `actorId` made the change, so is on the match screen
  // whether or not its socket is open yet - it isn't when a notification's button opened the app
  // to make it - and isn't pushed about it.
  private update(
    actorId: string,
    action: (match: MatchState) => MatchState | Promise<MatchState>
  ): Promise<MatchResult<MatchState>> {
    return this.read(async (match) => {
      const next = await action(match);
      await this.save(next);
      this.publish(match, next, [actorId]);
      await this.scheduleBotsIfNeeded(next);
      return next;
    });
  }

  // Schedules the next bot action a beat in the future (via the alarm API) if one is pending,
  // rather than resolving it inline - each bot move then arrives as its own broadcast, matching
  // the pacing a real remote player's move would have (bots.ts's botDelayMs).
  private async scheduleBotsIfNeeded(match: MatchState): Promise<void> {
    const action = findNextBotAction(match);
    if (action !== null) {
      await this.ctx.storage.setAlarm(Date.now() + botDelayMs(match, action));
    }
  }

  // Runs one bot action per firing. Alarm-driven changes never pass through routes/matches.ts,
  // which syncs the D1 lobby index for everything else, so it's synced here - by the same rules:
  // a bot's ready-up or play refreshes the summary row, and its bid or trump call (which the
  // routes don't sync either) writes nothing.
  async alarm(): Promise<void> {
    // Resolved before the match is read: the first call in an isolate makes outgoing ASSETS fetches,
    // which don't hold input gates, so a request could change the match between load and save.
    // With the kill switch off (BOTS_ENABLED 'false') bots already seated play on by the simple
    // rules, so no ML inference runs at all.
    const ml = botsEnabled(this.env) ? await getMlBot(this.env) : null;
    if (ml === WARMING) {
      // This invocation's CPU went on loading or warming up the model (getMlBot does one piece per
      // call), so the bot acts in a later one, shortly: the pacing delay has already passed.
      await this.ctx.storage.setAlarm(Date.now() + BOT_WARM_UP_TICK_MS);
      return;
    }
    const bot = ml;
    const match = await this.load();
    if (match === null) return;

    const action = findNextBotAction(match);
    if (action === null) return;

    const next = applyBotAction(match, action, bot);
    await this.save(next);
    // Scheduled straight after the save: the saved match already points at the next bot action,
    // so if anything below threw first, the runtime's retry would fire that action unpaced, and
    // once its retries ran out a match waiting on a bot would be stuck.
    await this.scheduleBotsIfNeeded(next);
    this.publish(match, next);
    if (action.kind === 'ready' || action.kind === 'play') {
      await bestEffort(next.id, () => refreshMatchSummary(this.env.DB, next));
    }
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
  // actions go through the REST routes, not over the socket. The server sends two kinds:
  // `{ type: 'match', match }` on every change, and `{ type: 'poke', from }` to a poked player.
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

  // Tells everyone about a change: each open socket gets the new match, and players who don't
  // have the match open get a push notification for anything they need to know (push/notices.ts)
  // - sent after the response, so a play never waits on the push service. `onTheWay` are players
  // counted as watching though no socket of theirs is open yet.
  private publish(previous: MatchState | null, next: MatchState, onTheWay: string[] = []): void {
    this.broadcast(next);
    const watching = this.watchingPlayers();
    for (const id of onTheWay) watching.add(id);
    const notices = pushNotices(previous, next).filter((n) => !watching.has(n.playerId));
    if (notices.length > 0) this.ctx.waitUntil(sendNotices(this.env, notices));
  }

  // Players with a socket open on this match: they're looking at it, so need no push. (The app
  // closes its socket when it goes to the background.)
  private watchingPlayers(): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as { playerId: string } | null;
      if (attachment) ids.add(attachment.playerId);
    }
    return ids;
  }

  // Every socket `playerId` has open on this match - one per tab or device.
  private socketsOf(playerId: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      const attachment = ws.deserializeAttachment() as { playerId: string } | null;
      return attachment?.playerId === playerId;
    });
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
