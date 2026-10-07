// The users table (migrations/0007_users.sql): what any player may see of another, kept in D1 so
// name lookups (POST /api/users/search, the lobby list) don't each cost an Auth0 Management API
// call - its rate limits are what would hurt first as play grows. Auth0 is only asked about players
// D1 hasn't seen, and what it returns is kept for next time.
import type { PublicUser } from '@fortytwo/api-types';
import { botDisplayName, isBot } from '@fortytwo/rules';
import type { Env } from '../index';
import { getUsers, MAX_USER_IDS, type Auth0User } from '../auth0Management';
import { toPublicUser } from './profile';

// Saves each player's name and picture. A row that already says the same is left alone - D1 bills
// every row written, and the apps fetch the profile on every launch.
export async function saveUsers(db: D1Database, users: PublicUser[], now: Date = new Date()): Promise<void> {
  if (users.length === 0) return;
  await db.batch(
    users.map((user) =>
      db
        .prepare(
          `INSERT INTO users (id, display_name, picture, updated_on) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (id) DO UPDATE SET display_name = ?2, picture = ?3, updated_on = ?4
           WHERE display_name IS NOT ?2 OR picture IS NOT ?3`
        )
        .bind(user.user_id, user.displayName, user.picture ?? null, now.toISOString())
    )
  );
}

// Keeps D1 in step with a player's own profile, fetched or just saved. Best-effort: the table is a
// cache, so failing to write it mustn't fail the request that carried the profile.
export async function rememberUser(db: D1Database, user: Auth0User): Promise<void> {
  try {
    await saveUsers(db, [toPublicUser(user)]);
  } catch (error) {
    console.error('Failed to save player name', error);
  }
}

async function storedUsers(db: D1Database, ids: string[]): Promise<PublicUser[]> {
  const found: PublicUser[] = [];
  for (let i = 0; i < ids.length; i += MAX_USER_IDS) {
    const chunk = ids.slice(i, i + MAX_USER_IDS);
    const placeholders = chunk.map((_, j) => `?${j + 1}`).join(', ');
    const { results } = await db
      .prepare(`SELECT id, display_name, picture FROM users WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ id: string; display_name: string; picture: string | null }>();
    for (const row of results) {
      found.push({ user_id: row.id, displayName: row.display_name, ...(row.picture != null && { picture: row.picture }) });
    }
  }
  return found;
}

// What each id is shown as: bots by number, everyone else from D1, and from Auth0 (then saved) for
// anyone D1 hasn't seen. Ids Auth0 doesn't know are left out, and the client shows them as
// "Player N". `complete` is false when Auth0 couldn't be asked about the players D1 hasn't seen -
// that's likely to pass (a blip, or its rate limit), so a caller may ask again rather than settle
// for what D1 had.
export async function publicUsers(env: Env, ids: string[]): Promise<{ users: PublicUser[]; complete: boolean }> {
  const unique = [...new Set(ids)];
  const bots = unique.filter(isBot).map((id): PublicUser => ({ user_id: id, displayName: botDisplayName(id) }));
  const humans = unique.filter((id) => !isBot(id));
  const stored = await storedUsers(env.DB, humans);
  const known = new Set(stored.map((user) => user.user_id));
  const missing = humans.filter((id) => !known.has(id));

  const fetched: PublicUser[] = [];
  let complete = true;
  try {
    for (let i = 0; i < missing.length; i += MAX_USER_IDS) {
      const users = await getUsers(env, missing.slice(i, i + MAX_USER_IDS));
      fetched.push(...users.map(toPublicUser));
    }
  } catch (error) {
    console.error('Failed to look players up in Auth0', error);
    complete = false;
  }
  try {
    await saveUsers(env.DB, fetched);
  } catch (error) {
    console.error('Failed to save player names', error);
  }
  return { users: [...bots, ...stored, ...fetched], complete };
}
