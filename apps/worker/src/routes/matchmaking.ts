// POST /api/matchmaking { mode }: Live or Async play. The Matchmaker (matchmaker.ts) seats the
// caller at an open table of that mode or starts one; the reply is that match, as the caller may
// see it, and the client opens it. Live needs bots to fill its seats, so it's off with them
// (BOTS_ENABLED 'false'), as adding bots is. A player has one Live game at a time: pressing Live
// while in one - still searching, or under way - takes them back to it.
import { Hono } from 'hono';
import type { AppEnv } from '../index';
import { botsEnabled } from '../bots';
import { bestEffort, findActiveLiveMatch, syncLobbyIndex } from '../lobby';
import * as field from '../requestBody';
import { readBody } from '../requestBody';
import { matchViewFor } from '@fortytwo/rules';

const matchmaking = new Hono<AppEnv>();

matchmaking.post('/', async (c) => {
  const mode = field.mode(await readBody(c));
  if (mode === 'live' && !botsEnabled(c.env)) return c.json({ title: 'Not found' }, 404);
  const userId = c.get('user').sub;
  if (mode === 'live') {
    const current = await findActiveLiveMatch(c.env.DB, userId);
    if (current !== null) {
      const found = await c.env.MATCH_DO.get(c.env.MATCH_DO.idFromName(current)).getMatch();
      // The index can lag: only a match that's still going, with the player still in it, counts.
      if (found.ok && found.value.winningTeam === null && found.value.players.some((p) => p.playerId === userId)) {
        return c.json(matchViewFor(found.value, userId));
      }
    }
  }
  const match = await c.env.MATCHMAKER.get(c.env.MATCHMAKER.idFromName('global')).play(userId, mode);
  await bestEffort(match.id, () => syncLobbyIndex(c.env.DB, match));
  return c.json(matchViewFor(match, userId));
});

export default matchmaking;
