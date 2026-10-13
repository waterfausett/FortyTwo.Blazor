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
import { hasBeenDealt, shuffledDominoOrder, TABLE_PAUSED, type MatchState } from '@fortytwo/rules';
import type { PresenceMessage } from '@fortytwo/api-types';
import { verifyToken } from './auth/verifyJwt';
import type { Env } from './index';

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

    // One Live search at a time: look at the whole list for a table this player already waits at
    // before seating them anywhere new, so an older table with room can't claim them too. Async
    // players may wait at several tables.
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
      for (const id of open) {
        const match = await this.heldMatch(id);
        if (match?.players.some((p) => p.playerId === playerId)) return match;
      }
    }

    const stillOpen: string[] = [];
    const underWay: string[] = [];
    let seated: MatchState | null = null;

    for (const id of open) {
      if (seated !== null) {
        stillOpen.push(id);
        continue;
      }
      try {
        const result = await this.trySeat(id, playerId, mode);
        if (result.keep) stillOpen.push(id);
        if (result.underWay) underWay.push(id);
        seated = result.seated;
      } catch {
        // A table that can't be reached may only be having a bad moment: keep it, try the next.
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

  // The table's match if it's one a seated player may be returned to: still looking for players
  // (under four, not dealt), or a game under way that isn't won. Else null. A game under way is
  // included so a human at it who presses play again gets it back, not a second table.
  private async heldMatch(id: string): Promise<MatchState | null> {
    try {
      const found = await this.matchStub(id).getMatch();
      if (!found.ok) return null;
      const filling = found.value.players.length < 4 && !hasBeenDealt(found.value);
      if (!filling && found.value.winningTeam !== null) return null;
      return found.value;
    } catch {
      return null;
    }
  }

  // Tries to seat the player at one table still filling: `seated` is where they ended up there
  // (null if nowhere), `keep` whether the table stays on the list, `underWay` whether it's a live
  // game already dealt, to try for a claim once no filling table took them.
  private async trySeat(
    id: string,
    playerId: string,
    mode: QueueMode
  ): Promise<{ seated: MatchState | null; keep: boolean; underWay?: boolean }> {
    const table = this.matchStub(id);
    let found = await table.getMatch();
    // Two goes: a refused seat (taken a moment ago) is retried once against a fresh read.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!found.ok) return { seated: null, keep: false };
      // Full or dealt: not filling. A live game not yet won stays listed for claims.
      if (found.value.players.length >= 4 || hasBeenDealt(found.value)) {
        const underWay = mode === 'live' && found.value.winningTeam === null;
        return { seated: null, keep: underWay, underWay };
      }
      const match = found.value;
      if (match.players.some((p) => p.playerId === playerId)) {
        // Live was caught by the pre-scan; an Async player may wait at several tables, so look on.
        return { seated: null, keep: true };
      }

      const seatAt = [0, 1, 2, 3].find((position) => match.players.every((p) => p.position !== position))!;
      const joined = await table.takeSeat(playerId, seatAt, shuffledDominoOrder());
      if (joined.ok) return { seated: joined.value, keep: joined.value.players.length < 4 };
      // A 404 is a deleted table; anything else (a seat taken a moment ago) may still have room.
      if (joined.status === 404) return { seated: null, keep: false };
      found = await table.getMatch();
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
