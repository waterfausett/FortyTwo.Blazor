// Hono routes for player profiles, backed by Auth0's Management API (auth0Management.ts).
import { Hono } from 'hono';
import type { AppEnv } from '../index';
import { getUser, getUsers, updateUser, type Auth0User } from '../auth0Management';
import { BadRequestError, profilePatch, readBody, readUserIds } from '../requestBody';
import { isExpoPushToken, removeToken, saveToken } from '../push/tokens';
import type { PublicUser, UserProfile } from '@fortytwo/api-types';

const users = new Hono<AppEnv>();

// An Auth0 user plus what to show them as, and their settings:
//   picture: their own user_metadata.picture when it isn't blank, else Auth0's.
//   displayName: user_metadata.displayName ?? nickname ?? name ?? email ?? "Unknown User ({id})".
//   highlightPlayable: off unless they've turned it on.
//   pushNotifications: on unless they've turned it off.
export function toUserResponse(u: Auth0User): UserProfile {
  const effectivePicture = u.user_metadata?.picture?.trim() ? u.user_metadata.picture : u.picture;
  const displayName =
    u.user_metadata?.displayName ?? u.nickname ?? u.name ?? u.email ?? `Unknown User (${u.user_id})`;
  return {
    ...u,
    picture: effectivePicture,
    displayName,
    highlightPlayable: u.user_metadata?.highlightPlayable === true,
    pushNotifications: u.user_metadata?.pushNotifications !== false,
  };
}

// What any player may see of another: enough to show them at the table, and nothing that
// identifies them outside the game (email, real name).
export function toPublicUser(u: Auth0User): PublicUser {
  const { user_id, displayName, picture } = toUserResponse(u);
  return { user_id, displayName, picture };
}

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
