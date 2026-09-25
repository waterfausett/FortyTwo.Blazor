// Hono routes ported from UsersController.cs, backed by auth0Management.ts (Task 15).
import { Hono } from 'hono';
import type { Env } from '../index';
import { getUser, getUsers, updateUser, type Auth0User } from '../auth0Management';

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

users.get('/profile', async (c) => {
  const user = await getUser(c.env, c.get('user').sub);
  return c.json(toUserResponse(user));
});

users.get('/', async (c) => {
  const all = await getUsers(c.env);
  return c.json(all.map(toUserResponse));
});

users.post('/search', async (c) => {
  const userIds = await c.req.json<string[]>();
  const found = await getUsers(c.env, userIds);
  return c.json(found.map(toUserResponse));
});

users.patch('/', async (c) => {
  const patch = await c.req.json<{ displayName?: string; theme?: 'Light' | 'Dark'; picture?: string }>();
  await updateUser(c.env, c.get('user').sub, patch);
  return c.body(null, 200);
});

export default users;
