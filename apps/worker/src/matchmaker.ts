// The Matchmaker: one Durable Object (addressed by name 'global') that answers "which table does
// this player sit at?" for Live and Async play. It keeps a seat index (seatIndex.ts): who sits
// where at each table still filling and each Live game under way (a newcomer may claim a bot seat
// in one). A search reads the index and makes one or two calls (take a seat, claim one, or start
// a table), not one per table. The waiting itself happens at that table (MatchDO): its socket shows
// the seats filling, and a Live one fills with bots on its own clock (live.ts).
//
// The index learns from two places. The Matchmaker's own calls hand back the table's listing with
// their result, refused or not, so a seat taken a moment ago corrects the index as it's found out.
// Every other change to a listing - bots took seats, someone left, a team got nearly home, the
// match finished or was deleted - the table reports (report()). A report can be lost; the index is
// then wrong about one table until a search next tries it, and the refusal sets it right. A Live
// player the index places at a table is sent back there only once that table confirms it.
//
// One key per table ('table:<id>'), held in memory once read: searches read no storage while this
// DO is awake, and each change writes the one table that changed.
import { DurableObject } from 'cloudflare:workers';
import { shuffledDominoOrder, type MatchState } from '@fortytwo/rules';
import type { PresenceMessage } from '@fortytwo/api-types';
import { verifyToken } from './auth/verifyJwt';
import type { Env } from './index';
import {
  applyListing,
  botTeam,
  canSeat,
  freeSeat,
  freeTeam,
  searchOrder,
  tablesOf,
  type Entry,
  type Listing,
  type QueueMode,
} from './seatIndex';

export type { QueueMode } from './seatIndex';

// Where a pair who searched together ended up: seated at one table, or not searched for because
// one or both of them is already in a Live game (`playerIds` names which).
export type PairResult = { kind: 'seated'; match: MatchState } | { kind: 'busy'; playerIds: string[] };

// Whether the online count is switched on (index.ts's PRESENCE_ENABLED). Off by default.
export function presenceEnabled(env: { PRESENCE_ENABLED?: string }): boolean {
  return env.PRESENCE_ENABLED === 'true';
}

// How often, at most, the online count goes out to every presence socket: index.ts's
// PRESENCE_BROADCAST_MS when set to at least MIN_PRESENCE_BROADCAST_MS, else
// DEFAULT_PRESENCE_BROADCAST_MS. The floor stops a typo from messaging every socket on each
// connect.
export const DEFAULT_PRESENCE_BROADCAST_MS = 5 * 60_000;
export const MIN_PRESENCE_BROADCAST_MS = 10_000;

// The PRESENCE_BROADCAST_MS last warned about, so a bad value is logged once per isolate rather
// than on every connect.
let warnedPresenceBroadcastMs: string | undefined;

export function presenceBroadcastMs(env: { PRESENCE_BROADCAST_MS?: string }): number {
  const raw = env.PRESENCE_BROADCAST_MS?.trim();
  if (!raw) return DEFAULT_PRESENCE_BROADCAST_MS;
  const ms = Number(raw);
  if (Number.isFinite(ms) && ms >= MIN_PRESENCE_BROADCAST_MS) return ms;
  if (warnedPresenceBroadcastMs !== raw) {
    warnedPresenceBroadcastMs = raw;
    console.warn(
      `PRESENCE_BROADCAST_MS "${raw}" ignored (not a number of at least ${MIN_PRESENCE_BROADCAST_MS}); using ${DEFAULT_PRESENCE_BROADCAST_MS}`
    );
  }
  return DEFAULT_PRESENCE_BROADCAST_MS;
}

// When to send a changed online count: now, if nothing has gone out in the last `windowMs`
// (presenceBroadcastMs); else when that is up, from one alarm - unless one is already set. A
// burst of apps opening at once thus costs one message per socket per window, not one each.
export function presenceBroadcast(
  now: number,
  lastSentAt: number | null,
  alarmAt: number | null,
  windowMs: number
): { kind: 'now' } | { kind: 'alarm'; at: number } | { kind: 'wait' } {
  if (lastSentAt === null || now - lastSentAt >= windowMs) return { kind: 'now' };
  if (alarmAt !== null) return { kind: 'wait' };
  return { kind: 'alarm', at: lastSentAt + windowMs };
}

function onlineMessage(online: number): string {
  return JSON.stringify({ type: 'online', online } satisfies PresenceMessage);
}

export class Matchmaker extends DurableObject<Env> {
  // Plays and reports run one at a time. DO input gates don't hold while this awaits a MatchDO
  // call, so two plays left to interleave could each find no open table and start one apiece.
  private queue: Promise<unknown> = Promise.resolve();
  // The seat index, once read from storage. Only this DO writes it, in turn, so it can't go stale;
  // dropped if a turn fails partway, to be read afresh.
  private tables: Map<string, Entry> | undefined;

  play(playerId: string, mode: QueueMode): Promise<MatchState> {
    return this.inTurn(() => this.seat(playerId, mode));
  }

  // Two partners from a finished Live game, searching together: seated as a team at one table, or
  // neither seated. Live only.
  playPair(a: string, b: string): Promise<PairResult> {
    return this.inTurn(() => this.seatPair(a, b));
  }

  // Which of these players sit or claim a seat at a Live table not yet won, as that table confirms
  // - other than `except`, a rematch a retry may already have made with them seated.
  liveBusy(playerIds: string[], except?: string): Promise<string[]> {
    return this.inTurn(async () => {
      const tables = await this.index();
      const busy: string[] = [];
      for (const playerId of playerIds) if ((await this.heldTable(tables, playerId, except)) !== null) busy.push(playerId);
      return busy;
    });
  }

  // A table's new listing, from its MatchDO, for a change the Matchmaker didn't make (null: the
  // table was deleted). Runs in the same queue as play, so it can't be lost under a play's write.
  report(matchId: string, mode: QueueMode, listing: Listing | null): Promise<void> {
    return this.inTurn(async () => this.apply(await this.index(), matchId, mode, listing));
  }

  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.queue.then(work).catch((error: unknown) => {
      this.tables = undefined;
      throw error;
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async index(): Promise<Map<string, Entry>> {
    if (this.tables !== undefined) return this.tables;
    const stored = await this.ctx.storage.list<Entry>({ prefix: 'table:' });
    const tables = new Map([...stored.values()].map((entry) => [entry.id, entry]));
    await this.migrate(tables);
    this.tables = tables;
    return tables;
  }

  // Before the index, the Matchmaker kept only ids ('open:live', 'open:daily') and each Live
  // claim ('claim:<playerId>'). Each listed table is looked at once, to index it.
  private async migrate(tables: Map<string, Entry>): Promise<void> {
    for (const mode of ['live', 'daily'] as const) {
      const open = await this.ctx.storage.get<string[]>(`open:${mode}`);
      if (open === undefined) continue;
      for (const id of open) {
        const looked = await this.matchStub(id).getListing().catch(() => null);
        if (looked !== null) await this.apply(tables, id, mode, looked.listing);
      }
      await this.ctx.storage.delete(`open:${mode}`);
    }
    const claims = [...(await this.ctx.storage.list({ prefix: 'claim:' })).keys()];
    for (let i = 0; i < claims.length; i += 128) await this.ctx.storage.delete(claims.slice(i, i + 128));
  }

  private async apply(tables: Map<string, Entry>, id: string, mode: QueueMode, listing: Listing | null): Promise<void> {
    const change = applyListing(tables, id, mode, listing);
    if (change?.kind === 'put') await this.ctx.storage.put(`table:${id}`, change.entry);
    else if (change?.kind === 'delete') await this.ctx.storage.delete(`table:${id}`);
  }

  private async seat(playerId: string, mode: QueueMode): Promise<MatchState> {
    const tables = await this.index();

    // A Live player has one table: one they wait at, play in, or claim a seat at takes them back.
    // Async players may wait at several.
    if (mode === 'live') {
      const held = await this.heldTable(tables, playerId);
      if (held !== null) return held;
    }

    // A table still filling, oldest first.
    for (const entry of searchOrder(tables, mode)) {
      const position = freeSeat(entry);
      if (entry.dealt || position === undefined || entry.seats.some((s) => s.playerId === playerId)) continue;
      const placed = await this.matchStub(entry.id).takeSeatListed(playerId, position, shuffledDominoOrder()).catch(() => null);
      // A table that can't be reached may only be having a bad moment: keep it, try the next.
      if (placed === null) continue;
      await this.apply(tables, entry.id, mode, placed.listing);
      if (placed.result.ok) return placed.result.value;
    }

    // No table is filling: claim a bot seat in a Live game under way, oldest first. One paused on
    // its last player refuses, and stays indexed: it may come back.
    if (mode === 'live') {
      for (const entry of searchOrder(tables, mode)) {
        if (!entry.dealt || !canSeat(entry)) continue;
        const placed = await this.matchStub(entry.id).claimSeatListed(playerId).catch(() => null);
        if (placed === null) continue;
        await this.apply(tables, entry.id, mode, placed.listing);
        if (placed.result.ok) return placed.result.value;
      }
    }

    const id = crypto.randomUUID();
    // Indexed ahead: if the Worker dies between creating the table and indexing it, the table isn't
    // orphaned. An id that never got a table drops itself the next time a search tries it (404).
    await this.apply(tables, id, mode, {
      seq: 0,
      seats: [{ playerId, position: 0 }],
      claims: [],
      dealt: false,
      won: false,
      takesClaims: false,
    });
    const created = await this.matchStub(id).createListed(playerId, id, mode);
    await this.apply(tables, id, mode, created.listing);
    if (!created.result.ok) throw new Error(`Table ${id} was not created: ${created.result.error.title}`);
    return created.result.value;
  }

  // The Live table this player sits or claims a seat at, not yet won, other than `except`. The index
  // may be behind (a report that they left was lost): the table has the last word.
  private async heldTable(tables: Map<string, Entry>, playerId: string, except?: string): Promise<MatchState | null> {
    for (const at of tablesOf(tables, 'live', playerId)) {
      if (at.id === except) continue;
      const looked = await this.matchStub(at.id).getListing().catch(() => null);
      if (looked === null) continue;
      await this.apply(tables, at.id, 'live', looked.listing);
      const { result } = looked;
      if (!result.ok || result.value.winningTeam !== null) continue;
      const match = result.value;
      if ((match.claims ?? []).includes(playerId) || match.players.some((p) => p.playerId === playerId)) return match;
    }
    return null;
  }

  private async seatPair(a: string, b: string): Promise<PairResult> {
    const tables = await this.index();

    // Neither may be in two Live games. Both already at one table is this same search retried.
    const heldA = await this.heldTable(tables, a);
    const heldB = await this.heldTable(tables, b);
    if (heldA !== null && heldA.id === heldB?.id) return { kind: 'seated', match: heldA };
    const busy = [heldA === null ? [] : [a], heldB === null ? [] : [b]].flat();
    if (busy.length > 0) return { kind: 'busy', playerIds: busy };

    // A table still filling with a whole team free, oldest first: they sit across from each other.
    for (const entry of searchOrder(tables, 'live')) {
      const team = freeTeam(entry);
      if (team === undefined) continue;
      const placed = await this.matchStub(entry.id).takeTeamListed(a, b, team, shuffledDominoOrder()).catch(() => null);
      if (placed === null) continue;
      await this.apply(tables, entry.id, 'live', placed.listing);
      if (placed.result.ok) return { kind: 'seated', match: placed.result.value };
    }

    // Then a Live game under way where bots hold a whole team: the pair claims both seats.
    for (const entry of searchOrder(tables, 'live')) {
      const team = botTeam(entry);
      if (team === undefined) continue;
      const placed = await this.matchStub(entry.id).claimTeamListed(a, b, team).catch(() => null);
      if (placed === null) continue;
      await this.apply(tables, entry.id, 'live', placed.listing);
      if (placed.result.ok) return { kind: 'seated', match: placed.result.value };
    }

    // A new table, indexed ahead with both seated, as seat() does.
    const id = crypto.randomUUID();
    await this.apply(tables, id, 'live', {
      seq: 0,
      seats: [
        { playerId: a, position: 0 },
        { playerId: b, position: 2 },
      ],
      claims: [],
      dealt: false,
      won: false,
      takesClaims: false,
    });
    const created = await this.matchStub(id).createTeamListed(a, b, id);
    await this.apply(tables, id, 'live', created.listing);
    if (!created.result.ok) throw new Error(`Table ${id} was not created: ${created.result.error.title}`);
    return { kind: 'seated', match: created.result.value };
  }

  private matchStub(id: string) {
    return this.env.MATCH_DO.get(this.env.MATCH_DO.idFromName(id));
  }

  // Presence sockets: one per signed-in app in the foreground (GET /presence/ws, index.ts). The
  // Hibernation API keeps them open without billing this DO for the time; clients never send on
  // them, so a connection costs one request to open and nothing after.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/presence/ws') return new Response('Not found', { status: 404 });
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
    pair[1].serializeAttachment({ playerId: user.sub });
    const online = this.online();
    pair[1].send(onlineMessage(online));
    // The new socket now holds a count the others may not: then the next broadcast is no repeat.
    if (online !== (await this.ctx.storage.get<number>('presenceSentCount'))) {
      await this.ctx.storage.delete('presenceSentCount');
    }
    await this.presenceChanged();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(): Promise<void> {}

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Only 1000 and 3000-4999 may be passed back to close() (see MatchDO.webSocketClose).
    if (code === 1000 || (code >= 3000 && code <= 4999)) ws.close(code, reason);
    else ws.close();
    await this.presenceChanged(ws);
  }

  // The online count changed: send it now, or leave it to the alarm (presenceBroadcast).
  private async presenceChanged(closing?: WebSocket): Promise<void> {
    const now = Date.now();
    const lastSentAt = (await this.ctx.storage.get<number>('presenceSentAt')) ?? null;
    const plan = presenceBroadcast(now, lastSentAt, await this.ctx.storage.getAlarm(), presenceBroadcastMs(this.env));
    if (plan.kind === 'now') await this.broadcastOnline(now, closing);
    else if (plan.kind === 'alarm') await this.ctx.storage.setAlarm(plan.at);
  }

  async alarm(): Promise<void> {
    await this.broadcastOnline(Date.now());
  }

  // Skipped when every socket already holds the count (presenceSentCount, which fetch() clears
  // once they don't): someone leaving and coming back before the alarm then costs no messages.
  // Nothing went out, so the next change needn't wait out the window (presenceBroadcastMs).
  private async broadcastOnline(now: number, closing?: WebSocket): Promise<void> {
    const online = this.online(closing);
    if (online === (await this.ctx.storage.get<number>('presenceSentCount'))) return;
    await this.ctx.storage.put({ presenceSentAt: now, presenceSentCount: online });
    const message = onlineMessage(online);
    for (const ws of this.ctx.getWebSockets()) if (ws !== closing) ws.send(message);
  }

  // Distinct players with a presence socket open; two tabs or devices count once. A socket being
  // closed may still be listed while its close is handled, so it's left out by name.
  private online(closing?: WebSocket): number {
    const players = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing) continue;
      const attachment = ws.deserializeAttachment() as { playerId: string } | null;
      if (attachment) players.add(attachment.playerId);
    }
    return players.size;
  }
}
