// The push_tokens table (migrations/0004_push_tokens.sql): which devices to notify for each
// player. The app registers its device's token after sign-in and removes it on sign-out or when
// the player turns notifications off.

export type PushPlatform = 'android' | 'ios';

// Expo push tokens look like ExponentPushToken[...] (or ExpoPushToken[...]).
export function isExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && /^Expo(nent)?PushToken\[[^\]]+\]$/.test(value);
}

// A device registering the same token again leaves the row alone - D1 bills every row written,
// and the app registers on each launch - apart from refreshing updated_on once this long has
// passed. (An app build with a bug registered in a loop, using up the day's D1 writes.)
export const TOKEN_REFRESH_MS = 24 * 60 * 60 * 1000;

export async function saveToken(
  db: D1Database,
  userId: string,
  token: string,
  platform: PushPlatform,
  now: Date = new Date()
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO push_tokens (token, user_id, platform, updated_on) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (token) DO UPDATE SET user_id = ?2, platform = ?3, updated_on = ?4
       WHERE user_id IS NOT ?2 OR platform IS NOT ?3 OR updated_on < ?5`
    )
    .bind(token, userId, platform, now.toISOString(), new Date(now.getTime() - TOKEN_REFRESH_MS).toISOString())
    .run();
}

// Only the token's owner may remove it.
export async function removeToken(db: D1Database, userId: string, token: string): Promise<void> {
  await db.prepare('DELETE FROM push_tokens WHERE token = ?1 AND user_id = ?2').bind(token, userId).run();
}

// Tokens Expo has said will never be delivered to again.
export async function forgetTokens(db: D1Database, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await db.batch(tokens.map((token) => db.prepare('DELETE FROM push_tokens WHERE token = ?1').bind(token)));
}

export async function tokensFor(db: D1Database, userIds: string[]): Promise<{ token: string; userId: string }[]> {
  if (userIds.length === 0) return [];
  const placeholders = userIds.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await db
    .prepare(`SELECT token, user_id FROM push_tokens WHERE user_id IN (${placeholders})`)
    .bind(...userIds)
    .all<{ token: string; user_id: string }>();
  return results.map((row) => ({ token: row.token, userId: row.user_id }));
}
