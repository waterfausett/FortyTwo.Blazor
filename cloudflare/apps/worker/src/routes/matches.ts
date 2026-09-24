// Hono routes wiring HTTP requests to MatchDO's RPC methods (matchDO.ts, Task 11), then syncing
// the D1 lobby index (lobby.ts, Task 13) from each returned MatchState. Every route calls the DO
// first, then syncs D1 - keeping D1-sync logic in one place per the spec, not inside the DO.
import { Hono } from 'hono';
import type { Env } from '../index';
import { upsertMatchSummary, syncMatchPlayers, listActive, listCompleted, listJoinable } from '../lobby';
import { createDomino, type MatchState } from '@fortytwo/rules';

type AppEnv = { Bindings: Env; Variables: { user: { sub: string } } };
const matches = new Hono<AppEnv>();

function stub(c: any, matchId: string) {
  return c.env.MATCH_DO.get(c.env.MATCH_DO.idFromName(matchId));
}

async function callRpc(matchDO: DurableObjectStub, method: string, body: Record<string, unknown>): Promise<Response> {
  return matchDO.fetch(`https://do/rpc/${method}`, { method: 'POST', body: JSON.stringify(body) });
}

// `matchEngine.ts`'s `createMatch()` mints its own internal `MatchState.id` via
// `crypto.randomUUID()`, completely independent of the `matchId` this route generates to address
// the MatchDO instance (`stub(c, matchId)` -> `idFromName(matchId)`) and key the D1 lobby-index
// row. Left uncorrected, a client would receive a `MatchState.id` in the response body that names
// no reachable Durable Object at all - any subsequent `GET /api/matches/:id` using that id would
// hit a brand-new, never-created DO and 404. `matchId` (the route's own address key) is always
// the authoritative identifier; every route that returns a MatchState normalizes `.id` to it
// before responding, so the id a client sees always matches the id it must use to reach this
// match again.
function withId(match: MatchState, matchId: string): MatchState {
  return { ...match, id: matchId };
}

async function syncLobby(c: any, matchId: string, match: MatchState): Promise<void> {
  await upsertMatchSummary(c.env.DB, {
    id: matchId,
    status: match.winningTeam ? 'completed' : 'active',
    playerCount: match.players.length,
    updatedOn: match.updatedOn,
  });
  await syncMatchPlayers(c.env.DB, matchId, match.players.map((p) => p.playerId));
}

// Builds a genuinely shuffled 28-domino deck using `createDomino()` (not hand-rolled
// `{ top, bottom }` objects) so every dealt Domino carries a real `.id` field - the
// `@fortytwo/rules` `Domino` type requires it, and MatchDO's RPC boundary does an unchecked
// `body.dealOrder as Domino[]` cast that would otherwise silently pass malformed objects straight
// into player hands. Shared by both the join route (below) and the ready-up route.
function shuffledDominoOrder() {
  const dominoes = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  for (let i = dominoes.length - 1; i > 0; i--) {
    const j = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * (i + 1));
    [dominoes[i], dominoes[j]] = [dominoes[j], dominoes[i]];
  }
  return dominoes;
}

matches.post('/', async (c) => {
  const userId = c.get('user').sub;
  const matchId = crypto.randomUUID();
  const res = await callRpc(stub(c, matchId), 'create', { firstPlayerId: userId });
  const match: MatchState = withId(await res.json(), matchId);
  await syncLobby(c, matchId, match);
  return c.json(match, 201);
});

matches.get('/', async (c) => {
  const userId = c.get('user').sub;
  const filter = c.req.query('filter') ?? 'Active';
  const rows =
    filter === 'Completed' ? await listCompleted(c.env.DB, userId) :
    filter === 'Joinable' ? await listJoinable(c.env.DB, userId) :
    await listActive(c.env.DB, userId);
  return c.json(rows);
});

// Full MatchState (all players, full game info) - backs the Match page's initial load and
// reconnect-catchup flow. Calls the unguarded `getMatch` RPC, NOT `getPlayerView` (which returns
// a narrow per-player DTO and is a different route, below).
matches.get('/:id', async (c) => {
  const matchId = c.req.param('id');
  const res = await callRpc(stub(c, matchId), 'getMatch', {});
  if (res.status !== 200) return c.json(await res.json(), res.status as 400);
  const match: MatchState = withId(await res.json(), matchId);
  return c.json(match);
});

// The narrow per-player DTO for the calling user - replaces `MatchPlayersController.Get` /
// `MatchService.GetPlayerForMatch`.
matches.get('/:id/players', async (c) => {
  const res = await callRpc(stub(c, c.req.param('id')), 'getPlayerView', { playerId: c.get('user').sub });
  if (res.status !== 200) return c.json(await res.json(), res.status as 400);
  return c.json(await res.json());
});

matches.post('/:id/players', async (c) => {
  const matchId = c.req.param('id');
  const userId = c.get('user').sub;
  const { team } = await c.req.json();
  // A shuffled dealOrder is generated on EVERY join: addPlayer (matchEngine.ts) only actually
  // deals when this is the 4th hand being added, but it's harmless (silently unused) on joins 2
  // and 3 - and this is the ONLY mechanism that ever deals a match's first hand, matching the
  // real app's behavior of dealing the instant the 4th player joins.
  const res = await callRpc(stub(c, matchId), 'addPlayer', { playerId: userId, team, dealOrder: shuffledDominoOrder() });
  if (res.status !== 200) return c.json(await res.json(), res.status as 400);
  const match: MatchState = withId(await res.json(), matchId);
  await syncLobby(c, matchId, match);
  return c.json(match);
});

matches.patch('/:id/players', async (c) => {
  const matchId = c.req.param('id');
  const userId = c.get('user').sub;
  const { ready } = await c.req.json();
  const dealOrder = ready ? shuffledDominoOrder() : undefined;
  const res = await callRpc(stub(c, matchId), 'readyUp', { playerId: userId, ready, dealOrder });
  if (res.status !== 200) return c.json(await res.json(), res.status as 400);
  const match: MatchState = withId(await res.json(), matchId);
  await syncLobby(c, matchId, match);
  return c.json(match);
});

matches.patch('/:id/games/current', async (c) => {
  const matchId = c.req.param('id');
  const { suit } = await c.req.json();
  const res = await callRpc(stub(c, matchId), 'setTrump', { playerId: c.get('user').sub, suit });
  if (res.status !== 200) return c.json(await res.json(), res.status as 400);
  const match: MatchState = withId(await res.json(), matchId);
  return c.json(match);
});

matches.post('/:id/games/current/bids', async (c) => {
  const matchId = c.req.param('id');
  const { bid } = await c.req.json();
  const res = await callRpc(stub(c, matchId), 'bid', { playerId: c.get('user').sub, bid });
  if (res.status !== 200) return c.json(await res.json(), res.status as 400);
  const match: MatchState = withId(await res.json(), matchId);
  return c.json(match);
});

matches.post('/:id/games/current/moves', async (c) => {
  const matchId = c.req.param('id');
  const { domino } = await c.req.json();
  const res = await callRpc(stub(c, matchId), 'playDomino', { playerId: c.get('user').sub, domino });
  if (res.status !== 200) return c.json(await res.json(), res.status as 400);
  const match: MatchState = withId(await res.json(), matchId);
  await syncLobby(c, matchId, match);
  return c.json(match);
});

export default matches;
