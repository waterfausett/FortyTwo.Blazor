// Hono routes for matches. Each one calls the match's MatchDO over RPC, syncs the D1 lobby index
// (lobby.ts) when the change can show up in the lobby, and replies with the match as the caller
// may see it. D1 syncing lives here, not in the DO, except for the changes no route makes. Syncing
// is best-effort (lobby.ts's `bestEffort`): the DO has saved the change by then, so a D1 failure is
// logged, not returned as a 500.
import { Hono, type Context } from 'hono';
import type { AppEnv, Env } from '../index';
import type { MatchResult } from '../matchDO';
import {
  bestEffort,
  syncLobbyIndex,
  refreshMatchSummary,
  deleteFromLobbyIndex,
  listActive,
  listCompleted,
  listJoinable,
  listMatchPlayers,
} from '../lobby';
import { botsEnabled } from '../bots';
import { publicUsers } from '../users/publicUsers';
import * as field from '../requestBody';
import { readBody } from '../requestBody';
import { Teams, matchMode, matchViewFor, seatedPlayers, shuffledDominoOrder, type MatchState } from '@fortytwo/rules';
import { turnSummaries, turnWaitsFor } from '../lobbyTurns';
import { decodeCursor, encodeCursor } from '../cursor';
import { createInvites, MAX_INVITES_PER_TABLE } from '../people/invites';
import { sendInvites } from '../push/send';
import type { HouseRules, InviteResult, MatchPage, MatchSummary } from '@fortytwo/api-types';

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
  const match = result.value;
  if (lobbySync === 'seats') await bestEffort(match.id, () => syncLobbyIndex(c.env.DB, match));
  if (lobbySync === 'summary') await bestEffort(match.id, () => refreshMatchSummary(c.env.DB, match));
  return c.json(matchViewFor(result.value, c.get('user').sub));
}

matches.post('/', async (c) => {
  const rules = field.houseRules(await field.readOptionalBody(c));
  const matchId = crypto.randomUUID();
  const match = await matchStub(c.env, matchId).create(c.get('user').sub, matchId, 'custom', rules);
  await bestEffort(matchId, () => syncLobbyIndex(c.env.DB, match));
  return c.json(matchViewFor(match, c.get('user').sub), 201);
});

// One tap to a match against three bots: created, seated, dealt (MatchDO's `createVsBots`).
// Off with bots, as adding them is.
matches.post('/bots', async (c) => {
  if (!botsEnabled(c.env)) return c.json({ title: 'Not found' }, 404);
  const matchId = crypto.randomUUID();
  const userId = c.get('user').sub;
  const match = await matchStub(c.env, matchId).createVsBots(userId, matchId);
  await bestEffort(matchId, () => syncLobbyIndex(c.env.DB, match));
  return c.json(matchViewFor(match, userId), 201);
});

matches.get('/', async (c) => {
  const userId = c.get('user').sub;
  const filter = c.req.query('filter') ?? 'Active';
  const cursor = decodeCursor(c.req.query('cursor'));
  const list = filter === 'Completed' ? listCompleted : filter === 'Joinable' ? listJoinable : listActive;
  const { rows, next } = await list(c.env.DB, userId, cursor);
  const playersByMatch = await listMatchPlayers(c.env.DB, rows.map((row) => row.id));
  const allPlayerIds = [...playersByMatch.values()].flat().map((p) => p.playerId);
  // The turn lookups (up to TURN_LOOKUP_MS) run alongside the names, not after them.
  const waitsPending = filter === 'Active' ? turnWaitsFor(c.env, rows) : null;
  const names = await displayNames(c.env, [...new Set(allPlayerIds)]);
  const nameOf = (playerId: string) => names.get(playerId) ?? playerId;
  const turns = waitsPending ? turnSummaries(await waitsPending, userId, nameOf) : null;
  const summaries = rows.map((row): MatchSummary => {
    const seated = playersByMatch.get(row.id) ?? [];
    const namesOn = (team: Teams) => seated.filter((p) => p.team === team).map((p) => nameOf(p.playerId));
    const seats = [0, 1, 2, 3].map((position) => {
      const player = seated.find((p) => p.position === position);
      return player ? nameOf(player.playerId) : null;
    });
    const { rules, ...rest } = row;
    return {
      ...rest,
      mode: row.mode ?? 'custom',
      ...(rules ? parsedRules(row.id, rules) : {}),
      teams: [namesOn(Teams.TeamA), namesOn(Teams.TeamB)],
      seats,
      ...(turns ? { turn: turns.get(row.id) ?? null } : {}),
    };
  });
  return c.json({ matches: summaries, nextCursor: next && encodeCursor(next) } satisfies MatchPage);
});

// The `rules` field for a lobby row. One corrupt column value leaves the rules off that row
// rather than failing the whole page.
function parsedRules(matchId: string, json: string): { rules?: HouseRules } {
  try {
    return { rules: JSON.parse(json) as HouseRules };
  } catch (error) {
    console.error('LOBBY RULES PARSE FAILED', matchId, error);
    return {};
  }
}

// Maps player ids to display names for the lobby list (users/publicUsers.ts: D1 first, Auth0 for
// players it hasn't seen, bots by number). Anyone it can't name keeps their id, even when Auth0
// is down - the list is still usable, which beats failing the whole lobby over a cosmetic field.
async function displayNames(env: Env, playerIds: string[]): Promise<Map<string, string>> {
  const { users } = await publicUsers(env, playerIds);
  return new Map(users.map((user) => [user.user_id, user.displayName]));
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

// Invites people to a custom table with an open seat (people/invites.ts), by push and in their
// Lobby. Only a player at the table may send them.
matches.post('/:id/invites', async (c) => {
  const userId = c.get('user').sub;
  const toIds = field.invitees(await readBody(c), MAX_INVITES_PER_TABLE);
  const result = await matchStub(c.env, c.req.param('id')).getMatch();
  if (!result.ok) return refusal(c, result);
  const match = result.value;
  if (!match.players.some((p) => p.playerId === userId)) {
    return c.json({ title: 'Not at this table', detail: 'Only players at the table can invite.' }, 403);
  }
  if (matchMode(match) !== 'custom') {
    return c.json({ title: "Can't invite here", detail: 'Only Custom Matches take invites.' }, 409);
  }
  if (match.winningTeam !== null) return c.json({ title: 'Match over', detail: 'This match has finished.' }, 409);
  if (seatedPlayers(match).length >= 4) return c.json({ title: 'Table is full', detail: 'Every seat is taken.' }, 409);
  const invited = await createInvites(c.env.DB, match, userId, toIds);
  if (invited === 'tooMany') {
    return c.json({ title: 'Too many invites', detail: `A table can send at most ${MAX_INVITES_PER_TABLE} invites.` }, 409);
  }
  if (invited.length > 0) {
    c.executionCtx.waitUntil(sendInvites(c.env, match.id, userId, invited));
  }
  return c.json({ invited } satisfies InviteResult);
});

// Seats a bot at `{ position }`, or at every open seat when no position is given, so bots can make
// up the numbers (404 when BOTS_ENABLED is 'false'). Only a player already at the table can add
// bots (checked by MatchDO's `addBots`).
matches.post('/:id/bots', async (c) => {
  if (!botsEnabled(c.env)) return c.json({ title: 'Not found' }, 404);
  const body = await readBody(c);
  const positions = body.position !== undefined ? [field.position(body)] : undefined;
  const result = await matchStub(c.env, c.req.param('id')).addBots(c.get('user').sub, positions);
  return replyWithMatch(c, result, { lobbySync: 'seats' });
});

// Readying up can finish a hand's wait and deal the next one, so it always carries a deck.
// `{ autopilot: false }` instead takes the caller's seat back from the bot (a Live turn ran out).
matches.patch('/:id/players', async (c) => {
  const body = await readBody(c);
  const match = matchStub(c.env, c.req.param('id'));
  if (body.autopilot !== undefined) {
    field.autopilotOff(body);
    return replyWithMatch(c, await match.resume(c.get('user').sub));
  }
  const result = await match.readyUp(c.get('user').sub, field.ready(body), shuffledDominoOrder());
  return replyWithMatch(c, result, { lobbySync: 'summary' });
});

// Leaves a match. Before the deal, the player is taken back out, and the last human out deletes
// it - which is how a creator cancels a match nobody joined. A newcomer waiting on a seat gives up
// their claim. In a Live Play game under way a bot takes the leaver's seat, unless nobody
// else is still playing, which deletes the match. A deleted match's lobby rows go too and the
// reply has no match to show. Leaving a match that's already gone counts as done, and clears any lobby row it left behind (a
// retry after a failed cleanup, or a row a slower sync re-inserted after the delete).
matches.delete('/:id/players', async (c) => {
  const matchId = c.req.param('id');
  const result = await matchStub(c.env, matchId).leave(c.get('user').sub);
  if (!result.ok && result.status !== 404) return refusal(c, result);
  if (!result.ok || result.value.deleted) {
    await bestEffort(matchId, () => deleteFromLobbyIndex(c.env.DB, matchId));
    return c.body(null, 204);
  }
  const { match } = result.value;
  await bestEffort(matchId, () => syncLobbyIndex(c.env.DB, match));
  return c.json(matchViewFor(match, c.get('user').sub));
});

// A vote to play the same four again once the match is over. The vote that completes the table
// also creates the rematch (MatchDO's `rematch`), which syncs its own lobby row; this route only
// syncs the finished match.
matches.post('/:id/rematch', async (c) => {
  const result = await matchStub(c.env, c.req.param('id')).rematch(c.get('user').sub);
  return replyWithMatch(c, result, { lobbySync: 'summary' });
});

// Pokes the player whose turn it is, once it's waited long enough (MatchDO's `poke`). The reply
// says how it reached them - a push, a nudge in the app, or not at all.
matches.post('/:id/poke', async (c) => {
  const result = await matchStub(c.env, c.req.param('id')).poke(c.get('user').sub);
  return result.ok ? c.json(result.value) : refusal(c, result);
});

// What the ML bot would do in the caller's seat, in a practice match (MatchDO's `hint`). The
// reply may be { status: 'warming' } while the model loads; the client asks again.
matches.get('/:id/games/current/hint', async (c) => {
  const result = await matchStub(c.env, c.req.param('id')).hint(c.get('user').sub);
  if (!result.ok) return refusal(c, result);
  return c.json(result.value);
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
