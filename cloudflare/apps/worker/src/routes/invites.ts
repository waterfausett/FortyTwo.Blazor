// Hono routes for the invites waiting for the caller (people/invites.ts): the Lobby's Invited to card.
import { Hono } from 'hono';
import type { AppEnv } from '../index';
import { dismissInvite, listInvites } from '../people/invites';

const invites = new Hono<AppEnv>();

invites.get('/', async (c) => c.json(await listInvites(c.env, c.get('user').sub)));

invites.delete('/:matchId', async (c) => {
  await dismissInvite(c.env.DB, c.get('user').sub, c.req.param('matchId'));
  return c.body(null, 204);
});

export default invites;
