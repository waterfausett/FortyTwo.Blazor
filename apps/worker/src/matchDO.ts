// Durable Object holding one match's authoritative state. Its public methods are called over
// Durable Object RPC (routes/matches.ts, and another MatchDO for a rematch); each one runs a
// `@fortytwo/rules` action, saves the result, and broadcasts it to the match's sockets.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { verifyToken } from './auth/verifyJwt';
import {
  type HouseRules,
  createMatch,
  addPlayer,
  takeSeat,
  patchPlayerReady,
  setTrump,
  playDomino,
  getPlayerView,
  matchViewFor,
  voteRematch,
  rematchAgreed,
  createRematch,
  removePlayer,
  hasHumanPlayers,
  liveDeadline,
  setAutopilot,
  isOnAutopilot,
  matchMode,
  resumeControl,
  tableWait,
  assertIsMatchPlayer,
  claimSeat,
  claimTeam,
  releaseClaim,
  replaceWithBot,
  isPresent,
  isBot,
  parkSeat,
  unpark,
  openPositions,
  hasBeenDealt,
  shuffledDominoOrder,
  offerParty,
  cancelParty,
  partyAgreed,
  partnerOf,
  moveOn,
  recordParty,
  teamForPosition,
  ValidationError,
  type Bid,
  type Domino,
  type LoggedInPlayer,
  type MatchMode,
  type MatchState,
  type Suit,
  type TableWait,
  type Teams,
} from '@fortytwo/rules';
import { bestEffort, syncLobbyIndex, refreshMatchSummary, deleteFromLobbyIndex } from './lobby';
import { recordMatchStats } from './stats';
import { pushNotices, type Notice } from './push/notices';
import { sendNotices } from './push/send';
import { tokensFor } from './push/tokens';
import { pokeNotice, pokeTarget, pokeTurnKey } from './poke';
import type { PokeResult } from '@fortytwo/api-types';
import { bidAndMaybeRedeal } from './redeal';
import { mintBotId, applyBotAction, botDelayMs, botsEnabled, findNextBotAction } from './bots';
import { WARMING, getMlBot } from './mlBot';
import { recordPlayedWith, startedPlayers } from './people/playedWith';
import { indexed, listingOf, sameListing, type Listing, type QueueMode } from './seatIndex';

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

// What the Matchmaker's own calls hand back: the call's result, and the table's listing after it
// (seatIndex.ts) - refused or not, so a refusal corrects the Matchmaker's index too. Null when
// there's no match here.
export interface Placement {
  result: MatchResult<MatchState>;
  listing: Listing | null;
}

export class MatchDO extends DurableObject<Env> {
  // The stored 'listing', once read: only this DO writes it, so it's read once per instance rather
  // than on every save. Undefined until then; null when there's none.
  private listing: Listing | null | undefined;

  private async load(): Promise<MatchState | null> {
    return (await this.ctx.storage.get<MatchState>('match')) ?? null;
  }

  private async storedListing(): Promise<Listing | null> {
    if (this.listing === undefined) this.listing = (await this.ctx.storage.get<Listing>('listing')) ?? null;
    return this.listing;
  }

  // Saves the match, and with it the table's listing for the Matchmaker's seat index when that
  // changed: who sits where, the claims, the deal, whether it's won or takes claims - a few times a
  // game, not every move. A change the Matchmaker didn't make itself (`report`) is reported to it
  // while its index holds the table, or should; the Matchmaker's own calls get the listing back
  // instead (Placement). Fire and forget: a lost report is found out when a search next tries the
  // table.
  private async save(match: MatchState, report = true): Promise<void> {
    const view = listingOf(match);
    const previous = view === null ? null : await this.storedListing();
    if (view === null || sameListing(view, previous ?? undefined)) {
      await this.ctx.storage.put('match', match);
      return;
    }
    const listing: Listing = { ...view, seq: (previous?.seq ?? 0) + 1 };
    await this.ctx.storage.put({ match, listing });
    this.listing = listing;
    const mode = matchMode(match) as QueueMode;
    if (report && (indexed(mode, listing) || (previous !== null && indexed(mode, previous)))) this.report(match, listing);
  }

  private report(match: MatchState, listing: Listing | null): void {
    const mode = matchMode(match) as QueueMode;
    this.ctx.waitUntil(
      this.matchmaker().report(match.id, mode, listing).catch((error: unknown) => console.error(`REPORT FAILED for ${match.id}`, error))
    );
  }

  // The listing to hand the Matchmaker with a result. A table stored before listings were kept
  // gets its first one now.
  private async placement(result: MatchResult<MatchState>): Promise<Placement> {
    const match = result.ok ? result.value : await this.load();
    if (match === null) return { result, listing: null };
    const stored = await this.storedListing();
    if (stored !== null) return { result, listing: stored };
    const view = listingOf(match);
    if (view === null) return { result, listing: null };
    const listing: Listing = { ...view, seq: 1 };
    await this.ctx.storage.put('listing', listing);
    this.listing = listing;
    return { result, listing };
  }

  // Deletes this match for good: no bot move may fire afterwards, every client is told to stop
  // reconnecting, and storage is wiped so a later call finds no match (404). The Matchmaker hears
  // of it if its index could still hold the table.
  private async destroy(match: MatchState): Promise<void> {
    const listing = await this.storedListing();
    await this.ctx.storage.deleteAlarm();
    for (const ws of this.ctx.getWebSockets()) {
      ws.close(MATCH_DELETED_CLOSE_CODE, 'Match deleted');
    }
    await this.ctx.storage.deleteAll();
    this.listing = null;
    if (listing !== null && indexed(matchMode(match) as QueueMode, listing)) this.report(match, null);
  }

  // Only the WebSocket upgrade still arrives as a request; everything else is an RPC method below.
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/ws') return this.handleWebSocketUpgrade(request);
    return new Response('Not found', { status: 404 });
  }

  // Stores the new match under `matchId`, the id this DO is addressed by, so every later response
  // and broadcast carries the id clients use to reach it.
  async create(firstPlayerId: string, matchId: string, mode: MatchMode = 'custom', rules?: HouseRules): Promise<MatchState> {
    const match = { ...createMatch(firstPlayerId, mode, rules), id: matchId };
    // Only the Matchmaker starts Live and Async tables, and it takes the listing from createListed.
    await this.save(match, false);
    this.publish(null, match);
    // A Live table's fill deadline starts now.
    await this.schedule(match);
    return match;
  }

  // `create`, for the Matchmaker: a Live or Async table, with its first listing.
  async createListed(firstPlayerId: string, matchId: string, mode: QueueMode): Promise<Placement> {
    return this.placement({ ok: true, value: await this.create(firstPlayerId, matchId, mode) });
  }

  // `createListed` for a pair who searched together: a at seat 0 and b at seat 2, so they're
  // partners from the start. Saved once with both seated, so there's never a table holding only one
  // of them. Neither has a socket open yet, so both are named as on their way and aren't pushed.
  async createTeamListed(a: string, b: string, matchId: string): Promise<Placement> {
    const first = { ...createMatch(a, 'live'), id: matchId };
    const match = takeSeat(first, b, 2);
    await this.save(match, false);
    this.publish(null, match, [a, b]);
    // The fill deadline starts now, as for any new Live table.
    await this.schedule(match);
    return this.placement({ ok: true, value: match });
  }

  // A match against three bots (the 'bots' mode): the player in seat 0 and bots in the rest, so
  // the 4th seat deals and it's under way when it's returned. Saved once, so there's never a
  // half-built table. `schedule` starts the bots off if one of them opens. The player is on their
  // way to it (their socket isn't open yet), so isn't pushed their own first turn.
  async createVsBots(playerId: string, matchId: string): Promise<MatchState> {
    const match = seatBots({ ...createMatch(playerId, 'bots'), id: matchId });
    await this.save(match);
    this.publish(null, match, [playerId]);
    await this.schedule(match);
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
      await this.schedule(stored);
      await bestEffort(matchId, () => syncLobbyIndex(this.env.DB, stored));
      return stored;
    }

    const match = createRematch(matchId, previous, dealOrder);
    await this.save(match);
    this.publish(null, match, onTheWay);
    await this.schedule(match);
    await bestEffort(matchId, () => syncLobbyIndex(this.env.DB, match));
    return match;
  }

  // The full stored match, every hand included. Routes narrow it to the caller's view before it
  // leaves the Worker (matchViewFor).
  getMatch(): Promise<MatchResult<MatchState>> {
    return this.read((match) => match);
  }

  // The Matchmaker's look at a table its index may be wrong about: the match, and its listing.
  async getListing(): Promise<Placement> {
    return this.placement(await this.getMatch());
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

  // `takeSeat`, for the Matchmaker.
  async takeSeatListed(playerId: string, position: number, dealOrder: Domino[]): Promise<Placement> {
    return this.placement(await this.update(playerId, (match) => takeSeat(match, playerId, position, dealOrder), false));
  }

  // `takeSeat` for a pair, in one update: both are seated or neither is. `dealOrder` goes with
  // both, since only the engine knows which of them sits down fourth and deals.
  async takeTeamListed(a: string, b: string, positions: [number, number], dealOrder: Domino[]): Promise<Placement> {
    const seat = (match: MatchState) => takeSeat(takeSeat(match, a, positions[0], dealOrder), b, positions[1], dealOrder);
    return this.placement(await this.update(a, seat, false, [a, b]));
  }

  // A newcomer asks for the next bot seat at this Live Play game. They're seated at the next hand
  // break; until then they watch.
  claimSeat(playerId: string): Promise<MatchResult<MatchState>> {
    return this.update(playerId, (match) => claimSeat(match, playerId));
  }

  // `claimSeat`, for the Matchmaker.
  async claimSeatListed(playerId: string): Promise<Placement> {
    return this.placement(await this.update(playerId, (match) => claimSeat(match, playerId), false));
  }

  // `claimTeam` for the Matchmaker: both claim their pinned seats, or neither does.
  async claimTeamListed(a: string, b: string, positions: [number, number]): Promise<Placement> {
    return this.placement(await this.update(a, (match) => claimTeam(match, a, b, positions), false, [a, b]));
  }

  // Leaving: before the deal, takes the player back out (the last human out deletes the match -
  // how a creator cancels a match nobody joined). A claimant gives up their claim. In an Over the
  // table game under way a bot takes the seat, unless nobody else is present, which drops the
  // match - as leaving a bots match under way always does, since bots never count as present. In a
  // Custom game under way a bot parks in the seat (parkSeat) to finish the hand and open it for
  // someone else, unless no other person is seated, which drops the match - connected or not.
  // Async games can't be left once dealt (removePlayer refuses). The caller drops the lobby rows when it's deleted (routes/matches.ts).
  leave(playerId: string): Promise<MatchResult<LeaveResult>> {
    return this.read(async (match): Promise<LeaveResult> => {
      if ((match.claims ?? []).includes(playerId)) {
        const next = releaseClaim(match, playerId);
        await this.save(next);
        this.broadcast(next);
        return { deleted: false, match: next };
      }
      const mode = matchMode(match);
      if ((mode === 'live' || mode === 'bots') && hasBeenDealt(match) && match.winningTeam === null) {
        assertIsMatchPlayer(match, playerId);
        const othersPresent = match.players.some((p) => p.playerId !== playerId && isPresent(match, p.playerId));
        if (!othersPresent) {
          await this.drop(match);
          return { deleted: true };
        }
        const next = replaceWithBot(match, playerId);
        await this.save(next);
        this.publish(match, next);
        await this.schedule(next);
        return { deleted: false, match: next };
      }
      if (mode === 'custom' && hasBeenDealt(match) && match.winningTeam === null) {
        assertIsMatchPlayer(match, playerId);
        if (!match.players.some((p) => p.playerId !== playerId && !isBot(p.playerId))) {
          await this.drop(match);
          return { deleted: true };
        }
        const next = parkSeat(match, playerId);
        await this.save(next);
        this.publish(match, next);
        await this.schedule(next);
        return { deleted: false, match: next };
      }
      const next = removePlayer(match, playerId);
      if (!hasHumanPlayers(next)) {
        await this.destroy(match);
        return { deleted: true };
      }
      await this.save(next);
      this.broadcast(next);
      await this.schedule(next);
      return { deleted: false, match: next };
    });
  }

  // Deletes this match if it is still active and was last changed before `cutoff`. This DO, not
  // the D1 row that led the sweep here, decides - the row is only an index and can lag behind.
  async expire(cutoff: string): Promise<ExpireOutcome> {
    const match = await this.load();
    if (match === null) return { outcome: 'missing' };
    if (match.winningTeam !== null || match.updatedOn >= cutoff) return { outcome: 'fresh', match };
    await this.destroy(match);
    return { outcome: 'expired' };
  }

  // Seats a bot at each of `positions`, or at every open seat when none are given, so people
  // testing together can fill out the table once everyone who's coming has sat down. Only someone
  // already at the table may do this. Each bot takes the first reserved id not yet seated.
  addBots(requesterId: string, positions?: number[]): Promise<MatchResult<MatchState>> {
    return this.update(requesterId, (match) => {
      assertIsMatchPlayer(match, requesterId);
      // Live fills with bots on its own clock; Async never does.
      if (matchMode(match) === 'daily') {
        throw new ValidationError('No bots at Async tables', 'Async tables only fill with people.');
      }
      // A parked bot in an open seat takes it for good; only seats nobody holds get a new bot.
      const parkedOpen = openPositions(match).filter((position) => match.players.some((p) => p.position === position));
      const unparked = unpark(match, positions ? positions.filter((position) => parkedOpen.includes(position)) : parkedOpen);
      return seatBots(unparked, positions?.filter((position) => !parkedOpen.includes(position)));
    });
  }

  readyUp(playerId: string, ready: boolean, dealOrder: Domino[]): Promise<MatchResult<MatchState>> {
    return this.update(playerId, (match) => patchPlayerReady(match, playerId, ready, dealOrder));
  }

  bid(playerId: string, bid: Bid): Promise<MatchResult<MatchState>> {
    return this.update(playerId, (match) => bidAndMaybeRedeal(match, playerId, bid));
  }

  setTrump(playerId: string, suit: Suit): Promise<MatchResult<MatchState>> {
    return this.update(playerId, (match) => setTrump(match, playerId, suit));
  }

  playDomino(playerId: string, domino: Domino): Promise<MatchResult<MatchState>> {
    return this.update(playerId, (match) => playDomino(match, playerId, domino));
  }

  // A player back at a Live table taking their seat back from the bot before their next turn.
  resume(playerId: string): Promise<MatchResult<MatchState>> {
    return this.update(playerId, (match) => resumeControl(match, playerId));
  }

  // Who the table is waiting on, for the lobby's Active list. A read of what this DO already
  // holds, so the list never needs D1 to keep a turn column up to date.
  getTurn(): Promise<MatchResult<TableWait | null>> {
    return this.read((match) => tableWait(match));
  }

  // Records a rematch vote. The vote that completes the table creates the rematch's DO first, and
  // only then does `rematchId` go on the match - every client follows it (off a broadcast, a
  // reload, or a reconnect), so it must never name a match that doesn't exist yet.
  //
  // The new id is minted once and kept under its own storage key before that call: DO input is
  // only gated on storage, not on an outgoing call, so another completing vote can run while it's
  // in flight and must reuse the id rather than mint a second match. If creation fails, this
  // throws before the vote is saved, so the voter's Rematch button stays live and trying again
  // finishes the job against the same (idempotent) id. For the same reason, whatever is saved
  // after an outgoing call is built on the match as stored by then (`reload`), not as first read.
  rematch(playerId: string): Promise<MatchResult<MatchState>> {
    return this.update(playerId, async (match) => {
      let next = voteRematch(match, playerId);
      if (next.rematchId !== undefined || rematchAgreed(next).length < next.players.length) return next;

      let rematchId = await this.ctx.storage.get<string>('pendingRematchId');
      // Nobody may be in two Live games. Anyone who has gone on to one is moved on, and no rematch
      // is made. The rematch a retried vote may already have made, with all four in it, isn't
      // another game.
      if (matchMode(next) === 'live') {
        const humans = next.players.map((p) => p.playerId).filter((id) => !isBot(id));
        const busy = await this.matchmaker().liveBusy(humans, rematchId);
        const latest = await this.reload();
        if (busy.length > 0) return busy.reduce((moved, id) => moveOn(moved, id, 'busy'), latest);
        // Someone may have moved on meanwhile, which refuses the vote, or the rematch may already
        // be made.
        next = voteRematch(latest, playerId);
        if (next.rematchId !== undefined || rematchAgreed(next).length < next.players.length) return next;
      }
      if (rematchId === undefined) {
        rematchId = crypto.randomUUID();
        await this.ctx.storage.put('pendingRematchId', rematchId);
      }

      const rematchDO = this.env.MATCH_DO.get(this.env.MATCH_DO.idFromName(rematchId));
      const onTheWay = [...new Set([playerId, ...this.watchingPlayers()])];
      await rematchDO.createRematch(rematchId, next, shuffledDominoOrder(), onTheWay);
      // The rematch exists now, so its id goes on the match even if someone moved on meanwhile:
      // they can still follow it, and the Matchmaker finds them seated there if they search.
      const latest = await this.reload();
      const votes = latest.rematchVotes ?? [];
      return { ...latest, rematchVotes: votes.includes(playerId) ? votes : [...votes, playerId], rematchId };
    });
  }

  // Offers to party up with the player's partner at the end of a Live game. The offer that
  // completes the pair has the Matchmaker seat them together, and only then does the new match's
  // id go on this one, so it never names a match that doesn't exist. If either of them is already
  // in another Live game, they're moved on instead and nobody is seated. A Matchmaker failure
  // throws before anything is saved, so the button stays live to try again.
  //
  // Other calls run while the Matchmaker works (the other team partying up, say), so the result
  // goes on the match as stored by then (`reload`). The pair is recorded even if one of them has
  // since pressed Find a game: they're seated at the new match all the same, and the Matchmaker
  // takes them back to it.
  partyUp(playerId: string): Promise<MatchResult<MatchState>> {
    return this.update(playerId, async (match) => {
      const next = offerParty(match, playerId);
      if (!partyAgreed(next, playerId)) return next;

      const placed = await this.matchmaker().playPair(playerId, partnerOf(next, playerId)!);
      if (placed.kind === 'busy') {
        return placed.playerIds.reduce((moved, id) => moveOn(moved, id, 'busy'), await this.reload());
      }

      const seat = next.players.find((p) => p.playerId === playerId)!.position;
      // No route touches the new match, so its lobby rows are written here, as for a rematch.
      await bestEffort(placed.match.id, () => syncLobbyIndex(this.env.DB, placed.match));
      return recordParty(await this.reload(), teamForPosition(seat), placed.match.id);
    });
  }

  cancelParty(playerId: string): Promise<MatchResult<MatchState>> {
    return this.update(playerId, (match) => cancelParty(assertLiveOver(match, playerId), playerId));
  }

  // The player went to find a game of their own (Find a game): they're done with this one.
  moveOn(playerId: string): Promise<MatchResult<MatchState>> {
    return this.update(playerId, (match) => moveOn(assertLiveOver(match, playerId), playerId, 'left'));
  }

  // The stored match, read again after an outgoing call: DO input is only gated on storage, so other
  // calls may have changed it while the call was out. Storage reads hold the gate, so nothing else
  // runs between this and `update`'s save.
  private async reload(): Promise<MatchState> {
    const match = await this.load();
    if (match === null) throw new ValidationError('Match not found!');
    return match;
  }

  private matchmaker() {
    return this.env.MATCHMAKER.get(this.env.MATCHMAKER.idFromName('global'));
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
  // to make it - and isn't pushed about it. `report` is false for the Matchmaker's own calls (save).
  // `onTheWay` is everyone who is on the screen, when it's more than the actor (a pair seated together).
  // An action that calls out of this DO builds its result on the match as stored after the call
  // (`reload`), so the change is published against that, not the match first read.
  private update(
    actorId: string,
    action: (match: MatchState) => MatchState | Promise<MatchState>,
    report = true,
    onTheWay: string[] = [actorId]
  ): Promise<MatchResult<MatchState>> {
    return this.read(async (match) => {
      const acted = await action(match);
      const previous = (await this.load()) ?? match;
      // Acting is taking your seat back from the bot (live.ts).
      const next = isOnAutopilot(acted, actorId) ? setAutopilot(acted, [actorId], false) : acted;
      await this.save(next, report);
      await this.recordStatsIfWon(previous, next);
      this.publish(previous, next, onTheWay);
      await this.schedule(next);
      await this.syncIfSeatsChanged(previous, next);
      return next;
    });
  }

  // Sets the alarm for whatever this match does next on its own: a bot's move a beat from now
  // (paced like a remote player's, bots.ts's botDelayMs), or a Live deadline (live.ts) - filling
  // the table, or a turn running out. One alarm serves all of them; alarm() works out which is due.
  private async schedule(match: MatchState): Promise<void> {
    const action = findNextBotAction(match);
    if (action !== null) {
      await this.ctx.storage.setAlarm(Date.now() + botDelayMs(match, action));
      return;
    }
    const deadline = liveDeadline(match);
    if (deadline !== null) await this.ctx.storage.setAlarm(Math.max(deadline.at, Date.now()));
  }

  // The play that wins the match records each human's stats (stats.ts) - only that one, so plays
  // after the match is over write nothing. A failure is logged loudly rather than thrown, like the
  // lobby sync: the play is already saved. Stats are counted from launch with no backfill, so a
  // failed write leaves that match out; watch the logs for this line. Called before the match is
  // published, so a broadcast that throws can't skip it without that line.
  private async recordStatsIfWon(previous: MatchState, next: MatchState): Promise<void> {
    if (previous.winningTeam !== null || next.winningTeam === null) return;
    try {
      await recordMatchStats(this.env.DB, next);
    } catch (error) {
      console.error(`PLAYER STATS WRITE FAILED for match ${next.id}`, error);
    }
  }

  // Runs one thing per firing: the next bot move, or a Live deadline that has come due (live.ts).
  // Alarm-driven changes never pass through routes/matches.ts, which syncs the D1 lobby index for
  // everything else, so it's synced here - by the same rules: a bot's ready-up or play refreshes
  // the summary row, and its bid or trump call (which the routes don't sync either) writes nothing.
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
    if (action !== null) {
      const next = applyBotAction(match, action, bot);
      await this.save(next);
      // Scheduled straight after the save: the saved match already points at the next bot action,
      // so if anything below threw first, the runtime's retry would fire that action unpaced, and
      // once its retries ran out a match waiting on a bot would be stuck.
      await this.schedule(next);
      await this.recordStatsIfWon(match, next);
      this.publish(match, next);
      await this.syncIfSeatsChanged(match, next);
      if (action.kind === 'ready' || action.kind === 'play') {
        await bestEffort(next.id, () => refreshMatchSummary(this.env.DB, next));
      }
      return;
    }

    const deadline = liveDeadline(match);
    if (deadline === null) return;
    // Fired early - the alarm was set for something that has since changed: wait for the deadline.
    if (Date.now() < deadline.at) {
      await this.schedule(match);
      return;
    }
    if (deadline.kind === 'drop') {
      await this.drop(match);
      return;
    }
    const next = deadline.kind === 'fill' ? seatBots(match) : setAutopilot(match, deadline.playerIds, true);
    await this.save(next);
    await this.schedule(next);
    this.publish(match, next);
    // Filling changes who's seated, which the lobby lists; going on autopilot doesn't.
    if (deadline.kind === 'fill') await bestEffort(next.id, () => syncLobbyIndex(this.env.DB, next));
  }

  // Drops a game with nobody left to play it: claimants hear they were let go (their app searches
  // again), then it's deleted like a match whose last player left. No stats are written.
  private async drop(match: MatchState): Promise<void> {
    const claims = match.claims ?? [];
    if (claims.length > 0) this.broadcast({ ...match, claims: [], bumped: [...(match.bumped ?? []), ...claims] });
    await this.destroy(match);
    await bestEffort(match.id, () => deleteFromLobbyIndex(this.env.DB, match.id));
  }

  // Who's seated changed in a game under way (a claim seated, a bot took over): the lobby lists it.
  // Joins and bots seated before the deal are left to the routes, which already sync them - syncing
  // them here too would write every seat row twice.
  private async syncIfSeatsChanged(previous: MatchState, next: MatchState): Promise<void> {
    if (!hasBeenDealt(previous)) return;
    const ids = (m: MatchState) => m.players.map((p) => `${p.position}:${p.playerId}`).sort().join();
    if (ids(previous) !== ids(next)) await bestEffort(next.id, () => syncLobbyIndex(this.env.DB, next));
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
    // would never receive any state.
    //
    // Someone who isn't seated may still connect (the lobby links to matches you haven't joined);
    // they just see every hand hidden, same as the REST route.
    //
    // No match here means it was deleted (a match is stored before anyone learns its id): a client
    // that was away when that happened missed destroy()'s close, so it gets the same close now
    // rather than sitting on the dead match's last state.
    const existing = await this.load();
    if (existing !== null) {
      pair[1].send(matchMessageFor(existing, user.sub));
    } else {
      pair[1].close(MATCH_DELETED_CLOSE_CODE, 'Match deleted');
    }

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Required by the Hibernation API even though clients don't send messages today - all match
  // actions go through the REST routes, not over the socket. The server sends two kinds:
  // `{ type: 'match', match, now }` on every change, and `{ type: 'poke', from }` to a poked player.
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
  // counted as watching though no socket of theirs is open yet. And, when a game starts, who
  // played with whom.
  private publish(previous: MatchState | null, next: MatchState, onTheWay: string[] = []): void {
    this.broadcast(next);
    const watching = this.watchingPlayers();
    for (const id of onTheWay) watching.add(id);
    const notices = noticesFor(previous, next, watching);
    if (notices.length > 0) this.ctx.waitUntil(sendNotices(this.env, notices));
    // A game starting: the People list's recent players (people/playedWith.ts).
    const started = startedPlayers(previous, next);
    if (started) this.ctx.waitUntil(bestEffort(next.id, () => recordPlayedWith(this.env.DB, started, next.updatedOn)));
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

// Party offers and moving on are only for the players of a Live match that is over; the rules'
// own functions for them don't check, since they're also used where that's already known.
function assertLiveOver(match: MatchState, playerId: string): MatchState {
  if (matchMode(match) !== 'live') throw new ValidationError('Only a Live game can do this');
  if (match.winningTeam === null) throw new ValidationError('This match is still being played');
  assertIsMatchPlayer(match, playerId);
  return match;
}

function matchMessageFor(match: MatchState, viewerId: string): string {
  // `now` lets the clients count Live deadlines down by this clock rather than their own
  // (@fortytwo/client's serverClock.ts).
  return JSON.stringify({ type: 'match', match: matchViewFor(match, viewerId), now: Date.now() });
}

// Seats a bot at each of `positions`, or at every open seat when none are given. Each bot takes
// the next free bot id (rules' mintBotId); the fourth seat deals.
function seatBots(match: MatchState, positions?: number[]): MatchState {
  const seats = positions ?? [0, 1, 2, 3].filter((position) => match.players.every((p) => p.position !== position));
  let next = match;
  for (const position of seats) {
    const botId = mintBotId(next.id, next.players.map((p) => p.playerId))!;
    next = takeSeat(next, botId, position, shuffledDominoOrder());
  }
  return next;
}

// What to push after a change: pushNotices' list, less anyone watching the match, and less anyone
// on autopilot - a bot is taking their turns, so a push per turn would only nag. The end of the
// match still reaches them.
export function noticesFor(previous: MatchState | null, next: MatchState, watching: Set<string>): Notice[] {
  return pushNotices(previous, next).filter(
    (n) => !watching.has(n.playerId) && (n.kind === 'matchOver' || !isOnAutopilot(next, n.playerId))
  );
}
