// Hono routes for player profiles, backed by Auth0's Management API (auth0Management.ts).
import { Hono } from 'hono';
import type { AppEnv } from '../index';
import { getUser, getUsers, updateUser } from '../auth0Management';
import { BadRequestError, profilePatch, readBody, readUserIds } from '../requestBody';
import { isExpoPushToken, removeToken, saveToken } from '../push/tokens';
import { toPublicUser, toUserResponse } from '../users/profile';

// They live in users/profile.ts (so users/publicUsers.ts can use them without importing the routes);
// re-exported here for the tests that import them from this module.
export { toPublicUser, toUserResponse };

const users = new Hono<AppEnv>();

// The caller's own full profile - the only route that returns email and name.
users.get('/profile', async (c) => {
  const user = await getUser(c.env, c.get('user').sub);
  return c.json(toUserResponse(user));
});

users.post('/search', async (c) => {
  const found = await getUsers(c.env, await readUserIds(c));
  return c.json(found.map(toPublicUser));
});

users.patch('/', async (c) => {
  await updateUser(c.env, c.get('user').sub, profilePatch(await readBody(c)));
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
