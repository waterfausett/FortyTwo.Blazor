// Hono routes for player profiles, backed by Auth0's Management API (auth0Management.ts) and the D1 `users` table
// of display names (users/publicUsers.ts).
import { Hono } from 'hono';
import type { AppEnv } from '../index';
import { getUser, updateUser } from '../auth0Management';
import { BadRequestError, profilePatch, readBody, readUserIds } from '../requestBody';
import { isExpoPushToken, removeToken, saveToken } from '../push/tokens';
import { toPublicUser, toUserResponse } from '../users/profile';
import { publicUsers, rememberUser } from '../users/publicUsers';

// They live in users/profile.ts (so users/publicUsers.ts can use them without importing the routes);
// re-exported here for the tests that import them from this module.
export { toPublicUser, toUserResponse };

const users = new Hono<AppEnv>();

// The caller's own full profile - the only route that returns email and name. Fetching it also
// refreshes what other players see of them (users/publicUsers.ts), which is how a name changed
// outside the app reaches the table.
users.get('/profile', async (c) => {
  const user = await getUser(c.env, c.get('user').sub);
  await rememberUser(c.env.DB, user);
  return c.json(toUserResponse(user));
});

users.post('/search', async (c) => {
  return c.json(await publicUsers(c.env, await readUserIds(c)));
});

users.patch('/', async (c) => {
  const user = await updateUser(c.env, c.get('user').sub, profilePatch(await readBody(c)));
  await rememberUser(c.env.DB, user);
  return c.body(null, 200);
});

// The caller's devices for push notifications (push/tokens.ts): the app registers its Expo push
// token after sign-in, and removes it on sign-out or when notifications are turned off.
users.put('/push-tokens', async (c) => {
  const body = await readBody(c);
  if (!isExpoPushToken(body.token)) throw new BadRequestError('`token` must be an Expo push token.');
  if (body.platform !== 'android' && body.platform !== 'ios') {
    throw new BadRequestError('`platform` must be "android" or "ios".');
  }
  await saveToken(c.env.DB, c.get('user').sub, body.token, body.platform);
  return c.body(null, 204);
});

users.delete('/push-tokens', async (c) => {
  const body = await readBody(c);
  if (!isExpoPushToken(body.token)) throw new BadRequestError('`token` must be an Expo push token.');
  await removeToken(c.env.DB, c.get('user').sub, body.token);
  return c.body(null, 204);
});

export default users;
