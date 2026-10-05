// Hono routes for matches. Each one calls the match's MatchDO over RPC, syncs the D1 lobby index
// (lobby.ts) when the change can show up in the lobby, and replies with the match as the caller
// may see it. D1 syncing lives here, not in the DO, except for the changes no route makes.
import { Hono, type Context } from 'hono';
import type { AppEnv, Env } from '../index';
import type { MatchResult } from '../matchDO';
import {
  syncLobbyIndex,
  refreshMatchSummary,
  deleteFromLobbyIndex,
  listActive,
  listCompleted,
  listJoinable,
  listMatchPlayers,
} from '../lobby';
import { isBot } from '../bots';
import { getUsers, MAX_USER_IDS } from '../auth0Management';
import { toUserResponse } from './users';
import * as field from '../requestBody';
import { readBody } from '../requestBody';
import { Teams, matchViewFor, shuffledDominoOrder, type MatchState } from '@fortytwo/rules';
import { decodeCursor, encodeCursor } from '../cursor';
import type { MatchPage, MatchSummary } from '@fortytwo/api-types';

type AppContext = Context<AppEnv>;
const matches = new Hono<AppEnv>();

function matchStub(env: Env, matchId: string) {
  return env.MATCH_DO.get(env.MATCH_DO.idFromName(matchId));
}

// A MatchDO refusal goes back as-is: its status, and the { title, detail } the client shows.
function refusal(c: AppContext, result: Extract<MatchResult<unknown>, { ok: false }>) {
  return c.json(result.error, result.status);
}

// Replies with a match action's result - the match as the caller may see it (their own hand, and
// only a count of everyone else's) - after syncing the lobby index when `lobbySync` is set:
// 'seats' for a change to who's seated, 'summary' for one that only moves the match along.
async function replyWithMatch(
  c: AppContext,
  result: MatchResult<MatchState>,
  { lobbySync }: { lobbySync?: 'seats' | 'summary' } = {}
) {
  if (!result.ok) return refusal(c, result);
  if (lobbySync === 'seats') await syncLobbyIndex(c.env.DB, result.value);
  if (lobbySync === 'summary') await refreshMatchSummary(c.env.DB, result.value);
  return c.json(matchViewFor(result.value, c.get('user').sub));
}

matches.post('/', async (c) => {
  const matchId = crypto.randomUUID();
  const match = await matchStub(c.env, matchId).create(c.get('user').sub, matchId);
  await syncLobbyIndex(c.env.DB, match);
  return c.json(matchViewFor(match, c.get('user').sub), 201);
});

matches.get('/', async (c) => {
  const userId = c.get('user').sub;
  const filter = c.req.query('filter') ?? 'Active';
  const cursor = decodeCursor(c.req.query('cursor'));
  const list = filter === 'Completed' ? listCompleted : filter === 'Joinable' ? listJoinable : listActive;
  const { rows, next } = await list(c.env.DB, userId, cursor);
  const playersByMatch = await listMatchPlayers(c.env.DB, rows.map((row) => row.id));
  const allPlayerIds = [...playersByMatch.values()].flat().map((p) => p.playerId);
  const names = await displayNames(c.env, [...new Set(allPlayerIds)]);
  const summaries = rows.map((row): MatchSummary => {
    const seated = playersByMatch.get(row.id) ?? [];
    const nameOf = (playerId: string) => names.get(playerId) ?? playerId;
    const namesOn = (team: Teams) => seated.filter((p) => p.team === team).map((p) => nameOf(p.playerId));
    const seats = [0, 1, 2, 3].map((position) => {
      const player = seated.find((p) => p.position === position);
      return player ? nameOf(player.playerId) : null;
    });
    return { ...row, teams: [namesOn(Teams.TeamA), namesOn(Teams.TeamB)], seats };
  });
  return c.json({ matches: summaries, nextCursor: next && encodeCursor(next) } satisfies MatchPage);
});

// Maps player ids to display names for the lobby list. Bots have no Auth0 account and keep their
// id ("bot-1"). A failed Auth0 lookup just leaves ids unnamed - the list is still usable showing
// raw ids, which beats failing the whole lobby over a cosmetic field.
async function displayNames(env: Env, playerIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const humans = playerIds.filter((id) => !isBot(id));
  try {
    for (let i = 0; i < humans.length; i += MAX_USER_IDS) {
      const users = await getUsers(env, humans.slice(i, i + MAX_USER_IDS));
      for (const user of users) names.set(user.user_id, toUserResponse(user).displayName);
    }
  } catch (error) {
    console.error('Failed to resolve player display names', error);
  }
  return names;
}

// The whole match as the caller may see it - backs the Match page's initial load and
// reconnect-catchup flow. Not limited to seated players: the lobby links to matches you haven't
// joined, and someone outside the match simply sees every hand hidden.
matches.get('/:id', async (c) => {
  return replyWithMatch(c, await matchStub(c.env, c.req.param('id')).getMatch());
});

// The calling player's own slice of the match (`LoggedInPlayer`).
matches.get('/:id/players', async (c) => {
  const result = await matchStub(c.env, c.req.param('id')).getPlayerView(c.get('user').sub);
  return result.ok ? c.json(result.value) : refusal(c, result);
});

matches.post('/:id/players', async (c) => {
  const match = matchStub(c.env, c.req.param('id'));
  const userId = c.get('user').sub;
  // `{ position }` sits the player in the seat they picked; `{ team }` is the older join-a-team
  // form, which lets the engine choose the seat.
  const body = await readBody(c);
  // Every join carries a shuffled deck; only the 4th player's join deals from it.
  const result =
    body.position !== undefined
      ? await match.takeSeat(userId, field.position(body), shuffledDominoOrder())
      : await match.addPlayer(userId, field.team(body), shuffledDominoOrder());
  return replyWithMatch(c, result, { lobbySync: 'seats' });
});

// Dev-only (AUTO_PLAY_BOTS): seats a bot at `{ position }`, or at every open seat when no position
// is given, so a few people can test together and let bots make up the numbers. Only a player
// already at the table can add bots (checked by MatchDO's `addBots`).
matches.post('/:id/bots', async (c) => {
  if (c.env.AUTO_PLAY_BOTS !== 'true') return c.json({ title: 'Not found' }, 404);
  const body = await readBody(c);
  const positions = body.position !== undefined ? [field.position(body)] : undefined;
  const result = await matchStub(c.env, c.req.param('id')).addBots(c.get('user').sub, positions);
  return replyWithMatch(c, result, { lobbySync: 'seats' });
});

// Readying up can finish a hand's wait and deal the next one, so it always carries a deck.
matches.patch('/:id/players', async (c) => {
  const ready = field.ready(await readBody(c));
  const result = await matchStub(c.env, c.req.param('id')).readyUp(c.get('user').sub, ready, shuffledDominoOrder());
  return replyWithMatch(c, result, { lobbySync: 'summary' });
});

// Leaves a match before its first deal. The last human out deletes it - which is how a creator
// cancels a match nobody joined - so its lobby rows go too and the reply has no match to show.
// Leaving a match that's already gone counts as done, and clears any lobby row it left behind (a
// retry after a failed cleanup, or a row a slower sync re-inserted after the delete).
matches.delete('/:id/players', async (c) => {
  const matchId = c.req.param('id');
  const result = await matchStub(c.env, matchId).leave(c.get('user').sub);
  if (!result.ok && result.status !== 404) return refusal(c, result);
  if (!result.ok || result.value.deleted) {
    await deleteFromLobbyIndex(c.env.DB, matchId);
    return c.body(null, 204);
  }
  await syncLobbyIndex(c.env.DB, result.value.match);
  return c.json(matchViewFor(result.value.match, c.get('user').sub));
});

// A vote to play the same four again once the match is over. The vote that completes the table
// also creates the rematch (MatchDO's `rematch`), which syncs its own lobby row; this route only
// syncs the finished match.
matches.post('/:id/rematch', async (c) => {
  const result = await matchStub(c.env, c.req.param('id')).rematch(c.get('user').sub);
  return replyWithMatch(c, result, { lobbySync: 'summary' });
});

matches.patch('/:id/games/current', async (c) => {
  const suit = field.suit(await readBody(c));
  return replyWithMatch(c, await matchStub(c.env, c.req.param('id')).setTrump(c.get('user').sub, suit));
});

matches.post('/:id/games/current/bids', async (c) => {
  const bid = field.bid(await readBody(c));
  return replyWithMatch(c, await matchStub(c.env, c.req.param('id')).bid(c.get('user').sub, bid));
});

matches.post('/:id/games/current/moves', async (c) => {
  const domino = field.domino(await readBody(c));
  const result = await matchStub(c.env, c.req.param('id')).playDomino(c.get('user').sub, domino);
  return replyWithMatch(c, result, { lobbySync: 'summary' });
});

export default matches;
