// Hono routes ported from UsersController.cs, backed by auth0Management.ts (Task 15).
import { Hono } from 'hono';
import type { Env } from '../index';
import { getUser, getUsers, updateUser, type Auth0User } from '../auth0Management';
import { profilePatch, readBody, readUserIds } from '../requestBody';

type AppEnv = { Bindings: Env; Variables: { user: { sub: string } } };
const users = new Hono<AppEnv>();

// The real C# `User` DTO (FortyTwo/Shared/DTO/User.cs) - what UsersController actually returns to
// clients - computes two fields beyond the raw Auth0 Management API shape:
//   Picture: prefers a non-blank user_metadata.Picture over the raw top-level Picture.
//   DisplayName: user_metadata.DisplayName ?? Nickname ?? Name ?? Email ?? "Unknown User ({id})".
// auth0Management.ts stays a pure Auth0 client (no computed fields); this response-shaping lives
// here since it's presentation logic, not "calling Auth0's API" (Correction E).
export function toUserResponse(u: Auth0User) {
  const effectivePicture = u.user_metadata?.picture?.trim() ? u.user_metadata.picture : u.picture;
  const displayName =
    u.user_metadata?.displayName ?? u.nickname ?? u.name ?? u.email ?? `Unknown User (${u.user_id})`;
  return { ...u, picture: effectivePicture, displayName };
}

// What any player may see of another: enough to show them at the table, and nothing that
// identifies them outside the game (email, real name).
export function toPublicUser(u: Auth0User) {
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

export default users;
