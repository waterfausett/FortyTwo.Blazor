// Hono routes wiring HTTP requests to MatchDO's RPC methods (matchDO.ts, Task 11), then syncing
// the D1 lobby index (lobby.ts, Task 13) from each returned MatchState. Every route calls the DO
// first, then syncs D1 - keeping D1-sync logic in one place per the spec, not inside the DO.
import { Hono } from 'hono';
import type { Env } from '../index';
import {
  upsertMatchSummary,
  syncMatchPlayers,
  listActive,
  listCompleted,
  listJoinable,
  listMatchPlayers,
} from '../lobby';
import { isBot, shuffledDominoOrder } from '../bots';
import { getUsers } from '../auth0Management';
import { toUserResponse } from './users';
import { Teams, matchViewFor, type MatchState } from '@fortytwo/rules';

type AppEnv = { Bindings: Env; Variables: { user: { sub: string } } };
const matches = new Hono<AppEnv>();

function stub(c: any, matchId: string) {
  return c.env.MATCH_DO.get(c.env.MATCH_DO.idFromName(matchId));
}

async function callRpc(matchDO: DurableObjectStub, method: string, body: Record<string, unknown>): Promise<Response> {
  return matchDO.fetch(`https://do/rpc/${method}`, { method: 'POST', body: JSON.stringify(body) });
}

// The match as the calling user may see it - their own hand, and only a count of everyone else's.
// Every route that returns a match goes through this; the DO's RPC replies carry every hand.
function matchView(c: any, match: MatchState) {
  return matchViewFor(match, c.get('user').sub);
}

async function syncLobby(c: any, matchId: string, match: MatchState): Promise<void> {
  await upsertMatchSummary(c.env.DB, {
    id: matchId,
    status: match.winningTeam ? 'completed' : 'active',
    playerCount: match.players.length,
    updatedOn: match.updatedOn,
  });
  await syncMatchPlayers(c.env.DB, matchId, match.players);
}

matches.post('/', async (c) => {
  const userId = c.get('user').sub;
  const matchId = crypto.randomUUID();
  // Passes this route's own DO-addressing `matchId` through to the `create` RPC so MatchDO can
  // store the match under that same id from the moment it's created (matchDO.ts's `create` case
  // overrides `createMatch()`'s own internally-minted id with it) - `matchEngine.ts`'s other
  // functions all preserve an existing match's `.id` unchanged, so this single correction at
  // creation time means every later REST response AND WebSocket broadcast naturally carries the
  // correct id forever after, with no per-response patching needed.
  const res = await callRpc(stub(c, matchId), 'create', { firstPlayerId: userId, matchId });
  const match: MatchState = await res.json();
  await syncLobby(c, matchId, match);
  return c.json(matchView(c, match), 201);
});

matches.get('/', async (c) => {
  const userId = c.get('user').sub;
  const filter = c.req.query('filter') ?? 'Active';
  const rows =
    filter === 'Completed' ? await listCompleted(c.env.DB, userId) :
    filter === 'Joinable' ? await listJoinable(c.env.DB, userId) :
    await listActive(c.env.DB, userId);
  const playersByMatch = await listMatchPlayers(c.env.DB, rows.map((row) => row.id));
  const allPlayerIds = [...playersByMatch.values()].flat().map((p) => p.playerId);
  const names = await displayNames(c, [...new Set(allPlayerIds)]);
  // `teams` is [TeamA names, TeamB names], each in join order, for a "A & B vs C & D" matchup.
  // `seats` is who sits at each position 0-3 (null for an open seat), for picking a seat to join.
  return c.json(
    rows.map((row) => {
      const seated = playersByMatch.get(row.id) ?? [];
      const nameOf = (playerId: string) => names.get(playerId) ?? playerId;
      const namesOn = (team: Teams) => seated.filter((p) => p.team === team).map((p) => nameOf(p.playerId));
      const seats = [0, 1, 2, 3].map((position) => {
        const player = seated.find((p) => p.position === position);
        return player ? nameOf(player.playerId) : null;
      });
      return { ...row, teams: [namesOn(Teams.TeamA), namesOn(Teams.TeamB)], seats };
    })
  );
});

// Auth0 caps a user search at 50 results per page, so look ids up in pages of that size.
const AUTH0_PAGE_SIZE = 50;

// Maps player ids to display names for the lobby list. Bots have no Auth0 account and keep their
// id ("bot-1"). A failed Auth0 lookup just leaves ids unnamed - the list is still usable showing
// raw ids, which beats failing the whole lobby over a cosmetic field.
async function displayNames(c: any, playerIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const humans = playerIds.filter((id) => !isBot(id));
  try {
    for (let i = 0; i < humans.length; i += AUTH0_PAGE_SIZE) {
      const users = await getUsers(c.env, humans.slice(i, i + AUTH0_PAGE_SIZE));
      for (const user of users) names.set(user.user_id, toUserResponse(user).displayName);
    }
  } catch (error) {
    console.error('Failed to resolve player display names', error);
  }
  return names;
}

// The whole match as the caller may see it (other hands reduced to counts) - backs the Match
// page's initial load and reconnect-catchup flow. Not limited to seated players: the lobby links
// to matches you haven't joined, and someone outside the match simply sees every hand hidden.
// `getPlayerView` is the narrow per-player DTO, a different route below.
matches.get('/:id', async (c) => {
  const matchId = c.req.param('id');
  const res = await callRpc(stub(c, matchId), 'getMatch', {});
  if (res.status !== 200) return c.json(await res.json(), res.status as 400);
  return c.json(matchView(c, await res.json()));
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
  // `{ position }` sits the player in the seat they picked; `{ team }` is the older join-a-team
  // form, which lets the engine choose the seat.
  const { team, position } = await c.req.json();
  // A shuffled dealOrder is generated on EVERY join: addPlayer/takeSeat (matchEngine.ts) only
  // actually deal when this is the 4th hand being added, but it's harmless (silently unused) on
  // joins 2 and 3 - and this is the ONLY mechanism that ever deals a match's first hand, matching
  // the real app's behavior of dealing the instant the 4th player joins.
  const dealOrder = shuffledDominoOrder();
  const res =
    position !== undefined
      ? await callRpc(stub(c, matchId), 'takeSeat', { playerId: userId, position, dealOrder })
      : await callRpc(stub(c, matchId), 'addPlayer', { playerId: userId, team, dealOrder });
  if (res.status !== 200) return c.json(await res.json(), res.status as 400);
  const match: MatchState = await res.json();
  await syncLobby(c, matchId, match);
  return c.json(matchView(c, match));
});

// Dev-only (AUTO_PLAY_BOTS): seats a bot at `{ position }`, or at every open seat when no position
// is given, so a few people can test together and let bots make up the numbers. Only a player
// already at the table can add bots (checked by MatchDO's `addBots`).
matches.post('/:id/bots', async (c) => {
  if (c.env.AUTO_PLAY_BOTS !== 'true') return c.json({ title: 'Not found' }, 404);
  const matchId = c.req.param('id');
  const { position } = await c.req.json();
  const res = await callRpc(stub(c, matchId), 'addBots', {
    requesterId: c.get('user').sub,
    positions: position !== undefined ? [position] : undefined,
  });
  if (res.status !== 200) return c.json(await res.json(), res.status as 400);
  const match: MatchState = await res.json();
  await syncLobby(c, matchId, match);
  return c.json(matchView(c, match));
});

matches.patch('/:id/players', async (c) => {
  const matchId = c.req.param('id');
  const userId = c.get('user').sub;
  const { ready } = await c.req.json();
  const dealOrder = ready ? shuffledDominoOrder() : undefined;
  const res = await callRpc(stub(c, matchId), 'readyUp', { playerId: userId, ready, dealOrder });
  if (res.status !== 200) return c.json(await res.json(), res.status as 400);
  const match: MatchState = await res.json();
  await syncLobby(c, matchId, match);
  return c.json(matchView(c, match));
});

matches.patch('/:id/games/current', async (c) => {
  const { suit } = await c.req.json();
  const res = await callRpc(stub(c, c.req.param('id')), 'setTrump', { playerId: c.get('user').sub, suit });
  if (res.status !== 200) return c.json(await res.json(), res.status as 400);
  return c.json(matchView(c, await res.json()));
});

matches.post('/:id/games/current/bids', async (c) => {
  const { bid } = await c.req.json();
  const res = await callRpc(stub(c, c.req.param('id')), 'bid', { playerId: c.get('user').sub, bid });
  if (res.status !== 200) return c.json(await res.json(), res.status as 400);
  return c.json(matchView(c, await res.json()));
});

matches.post('/:id/games/current/moves', async (c) => {
  const matchId = c.req.param('id');
  const { domino } = await c.req.json();
  const res = await callRpc(stub(c, matchId), 'playDomino', { playerId: c.get('user').sub, domino });
  if (res.status !== 200) return c.json(await res.json(), res.status as 400);
  const match: MatchState = await res.json();
  await syncLobby(c, matchId, match);
  return c.json(matchView(c, match));
});

export default matches;
