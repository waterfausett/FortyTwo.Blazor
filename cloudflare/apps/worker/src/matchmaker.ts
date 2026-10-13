// The Matchmaker: one Durable Object (addressed by name 'global') that answers "which table does
// this player sit at?" for Live and Async play. It keeps, per mode, the ids of tables still
// looking for players, oldest first, and seats the player at the first that takes them - or
// starts a new one. The waiting itself happens at that table (MatchDO): its socket shows the
// seats filling, and a Live one fills with bots on its own clock (live.ts).
//
// Live Play games stay on the list while they're under way, because a bot's seat in
// one can be claimed by a newcomer at the next hand break. A newcomer is seated at a table still
// filling first, then claims a bot seat in the oldest game under way that takes them. A game that
// refuses a claim (finished, nearly over, every bot seat claimed) or was deleted is found out then
// and dropped - though one paused on its last player stays listed, as it may come back; MatchDO
// offers a table back when a bot takes a seat there later. An Async table that filled (through
// here, an invite link, or bots) is likewise dropped at the next refused seat.
import { DurableObject } from 'cloudflare:workers';
import { shuffledDominoOrder, TABLE_PAUSED, type MatchState } from '@fortytwo/rules';
import type { PresenceMessage } from '@fortytwo/api-types';
import { verifyToken } from './auth/verifyJwt';
import type { Env } from './index';
import type { MatchResult, Seating } from './matchDO';

export type QueueMode = 'live' | 'daily';

// How often, at most, the online count goes out to every presence socket.
// Whether the online count is switched on (index.ts's PRESENCE_ENABLED). Off by default.
export function presenceEnabled(env: { PRESENCE_ENABLED?: string }): boolean {
  return env.PRESENCE_ENABLED === 'true';
}

export const PRESENCE_BROADCAST_MS = 60_000;

// When to send a changed online count: now, if nothing has gone out in the last
// PRESENCE_BROADCAST_MS; else at the end of that minute, from one alarm - unless one is already
// set. A burst of apps opening at once thus costs one message per socket a minute, not one each.
export function presenceBroadcast(
  now: number,
  lastSentAt: number | null,
  alarmAt: number | null
): { kind: 'now' } | { kind: 'alarm'; at: number } | { kind: 'wait' } {
  if (lastSentAt === null || now - lastSentAt >= PRESENCE_BROADCAST_MS) return { kind: 'now' };
  if (alarmAt !== null) return { kind: 'wait' };
  return { kind: 'alarm', at: lastSentAt + PRESENCE_BROADCAST_MS };
}

function onlineMessage(online: number): string {
  return JSON.stringify({ type: 'online', online } satisfies PresenceMessage);
}

export class Matchmaker extends DurableObject<Env> {
  // Plays run one at a time. DO input gates don't hold while this awaits a MatchDO call, so two
  // plays left to interleave could each find no open table and start one apiece.
  private queue: Promise<unknown> = Promise.resolve();

  play(playerId: string, mode: QueueMode): Promise<MatchState> {
    const turn = this.queue.then(() => this.seat(playerId, mode));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  // A table with a seat for a newcomer, from its MatchDO (a bot just sat down there). Runs in the
  // same queue as play, so it can't be lost under a play's write.
  offer(matchId: string): Promise<void> {
    const turn = this.queue.then(async () => {
      const open = (await this.ctx.storage.get<string[]>('open:live')) ?? [];
      if (!open.includes(matchId)) await this.ctx.storage.put('open:live', [...open, matchId]);
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async seat(playerId: string, mode: QueueMode): Promise<MatchState> {
    const key = `open:${mode}`;
    const open = (await this.ctx.storage.get<string[]>(key)) ?? [];

    if (mode === 'live') {
      // A claim made earlier holds while the game is on and still lists the player; otherwise it's
      // forgotten and the player searches afresh.
      const claimed = await this.ctx.storage.get<string>(`claim:${playerId}`);
      if (claimed !== undefined) {
        const found = await this.matchStub(claimed).getMatch().catch(() => null);
        const holds =
          found?.ok === true &&
          found.value.winningTeam === null &&
          ((found.value.claims ?? []).includes(playerId) || found.value.players.some((p) => p.playerId === playerId));
        if (found?.ok && holds) return found.value;
        await this.ctx.storage.delete(`claim:${playerId}`);
      }
    }

    // One Live search at a time: every table is looked at up front for one this player already
    // waits at or plays in, before seating them anywhere new, so an older table with room can't
    // claim them too. Async players may wait at several tables, so theirs are looked at only as far
    // as the one that seats them. Either way each table is looked at once, and the look is what
    // seating goes by - a Seating, not the whole match.
    const looks = mode === 'live' ? await Promise.all(open.map((id) => this.look(id))) : null;

    if (looks !== null) {
      const at = open.find((_id, i) => {
        const look = looks[i];
        return look?.ok === true && !look.value.won && look.value.players.some((p) => p.playerId === playerId);
      });
      if (at !== undefined) {
        const found = await this.matchStub(at).getMatch().catch(() => null);
        if (found?.ok) return found.value;
      }
    }

    const stillOpen: string[] = [];
    const underWay: string[] = [];
    let seated: MatchState | null = null;

    for (const [i, id] of open.entries()) {
      if (seated !== null) {
        stillOpen.push(id);
        continue;
      }
      const look = looks !== null ? looks[i] : await this.look(id);
      // A table that can't be reached may only be having a bad moment: keep it, try the next.
      if (look === null) {
        stillOpen.push(id);
        continue;
      }
      try {
        const result = await this.trySeat(id, look, playerId, mode);
        if (result.keep) stillOpen.push(id);
        if (result.underWay) underWay.push(id);
        seated = result.seated;
      } catch {
        stillOpen.push(id);
      }
    }

    // No table is filling: take a bot seat in a game under way, oldest first.
    if (seated === null && mode === 'live') {
      for (const id of underWay) {
        const claimed = await this.matchStub(id).claimSeat(playerId).catch(() => null);
        // A call that threw may only be a bad moment: keep the game listed, try the next.
        if (claimed === null) continue;
        if (claimed.ok) {
          seated = claimed.value;
          await this.ctx.storage.put(`claim:${playerId}`, id);
          break;
        }
        // Paused on its last player: it may yet come back, with no bot taking a seat to offer it
        // again, so it stays listed.
        if (claimed.error.title === TABLE_PAUSED) continue;
        // Finished, nearly over, every bot seat claimed, or gone: off the list. A bot taking a seat
        // there later offers it back.
        const at = stillOpen.indexOf(id);
        if (at !== -1) stillOpen.splice(at, 1);
      }
    }

    if (seated === null) {
      const id = crypto.randomUUID();
      // Written ahead: if the Worker dies between creating the table and saving the list, the
      // table isn't orphaned. An id that never got a table drops itself on the next look (404).
      await this.ctx.storage.put(key, [...stillOpen, id]);
      seated = await this.matchStub(id).create(playerId, id, mode);
      return seated;
    }
    await this.ctx.storage.put(key, stillOpen);
    return seated;
  }

  // One table's Seating, or null if it couldn't be reached.
  private async look(id: string): Promise<MatchResult<Seating> | null> {
    try {
      return await this.matchStub(id).getSeating();
    } catch {
      return null;
    }
  }

  // Tries to seat the player at one table still filling, from the look already taken at it:
  // `seated` is where they ended up there (null if nowhere), `keep` whether the table stays on the
  // list, `underWay` whether it's a live game already dealt, to try for a claim once no filling
  // table took them.
  private async trySeat(
    id: string,
    look: MatchResult<Seating>,
    playerId: string,
    mode: QueueMode
  ): Promise<{ seated: MatchState | null; keep: boolean; underWay?: boolean }> {
    const table = this.matchStub(id);
    let found = look;
    // Two goes: a refused seat (taken a moment ago) is retried once against a fresh look.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!found.ok) return { seated: null, keep: false };
      const { players, dealt, won } = found.value;
      // Full or dealt: not filling. A live game not yet won stays listed for claims.
      if (players.length >= 4 || dealt) {
        const underWay = mode === 'live' && !won;
        return { seated: null, keep: underWay, underWay };
      }
      if (players.some((p) => p.playerId === playerId)) {
        // Live was caught by the look up front; an Async player may wait at several tables, so look on.
        return { seated: null, keep: true };
      }

      const seatAt = [0, 1, 2, 3].find((position) => players.every((p) => p.position !== position))!;
      const joined = await table.takeSeat(playerId, seatAt, shuffledDominoOrder());
      if (joined.ok) return { seated: joined.value, keep: joined.value.players.length < 4 };
      // A 404 is a deleted table; anything else (a seat taken a moment ago) may still have room.
      if (joined.status === 404) return { seated: null, keep: false };
      found = await table.getSeating();
    }
    return { seated: null, keep: true };
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
    pair[1].send(onlineMessage(this.online()));
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
    const plan = presenceBroadcast(now, lastSentAt, await this.ctx.storage.getAlarm());
    if (plan.kind === 'now') await this.broadcastOnline(now, closing);
    else if (plan.kind === 'alarm') await this.ctx.storage.setAlarm(plan.at);
  }

  async alarm(): Promise<void> {
    await this.broadcastOnline(Date.now());
  }

  private async broadcastOnline(now: number, closing?: WebSocket): Promise<void> {
    await this.ctx.storage.put('presenceSentAt', now);
    const message = onlineMessage(this.online(closing));
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
