// The People list (GET /api/people) and its search: friends the caller has starred (friends,
// one-way - the other person isn't told), then people they've played with (played_with, written
// by MatchDO), named from the users table as the rest of the app does (users/publicUsers.ts).
import type { PeopleView, Person, PublicUser } from '@fortytwo/api-types';
import type { Env } from '../index';
import { publicUsers } from '../users/publicUsers';

export const RECENT_LIMIT = 30;
export const FRIENDS_LIMIT = 100;
export const SEARCH_LIMIT = 20;
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 40;

interface Row {
  id: string;
  is_friend: number;
  last_played_on: string | null;
  games: number | null;
}

function toPerson(user: PublicUser, row: Row): Person {
  return { ...user, isFriend: row.is_friend === 1, lastPlayedOn: row.last_played_on, games: row.games ?? 0 };
}

// Anyone the users table and Auth0 can't name is left out rather than failing the list. `show`
// limits it to friends or recent players; without it, friends then recent players.
export async function listPeople(env: Env, userId: string, show?: PeopleView): Promise<Person[]> {
  const friendsQuery = env.DB.prepare(
    `SELECT f.friend_id AS id, 1 AS is_friend, pw.last_played_on, pw.games
     FROM friends f LEFT JOIN played_with pw ON pw.user_id = f.user_id AND pw.other_id = f.friend_id
     WHERE f.user_id = ?1 ORDER BY f.created_on DESC LIMIT ${FRIENDS_LIMIT}`
  ).bind(userId);
  const recentQuery = env.DB.prepare(
    `SELECT pw.other_id AS id, 0 AS is_friend, pw.last_played_on, pw.games
     FROM played_with pw
     WHERE pw.user_id = ?1 AND NOT EXISTS (SELECT 1 FROM friends f WHERE f.user_id = ?1 AND f.friend_id = pw.other_id)
     ORDER BY pw.last_played_on DESC LIMIT ${RECENT_LIMIT}`
  ).bind(userId);
  const queries = show === 'friends' ? [friendsQuery] : show === 'recent' ? [recentQuery] : [friendsQuery, recentQuery];
  const rows = (await env.DB.batch<Row>(queries)).flatMap((r) => r.results);
  if (rows.length === 0) return [];
  const { users } = await publicUsers(env, rows.map((r) => r.id));
  const byId = new Map(users.map((u) => [u.user_id, u]));
  return rows.flatMap((row) => {
    const user = byId.get(row.id);
    return user ? [toPerson(user, row)] : [];
  });
}

// A case-insensitive prefix match on display names, as a range rather than LIKE so `%` and `_`
// in a name are just characters, and so it can use users_display_name (COLLATE NOCASE).
export async function searchPeople(db: D1Database, userId: string, q: string): Promise<Person[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.display_name, u.picture, (f.friend_id IS NOT NULL) AS is_friend, pw.last_played_on, pw.games
       FROM users u
       LEFT JOIN friends f ON f.user_id = ?1 AND f.friend_id = u.id
       LEFT JOIN played_with pw ON pw.user_id = ?1 AND pw.other_id = u.id
       WHERE u.display_name >= ?2 COLLATE NOCASE AND u.display_name < ?3 COLLATE NOCASE AND u.id <> ?1
       ORDER BY u.display_name COLLATE NOCASE LIMIT ${SEARCH_LIMIT}`
    )
    .bind(userId, q, `${q}\uffff`)
    .all<Row & { display_name: string; picture: string | null }>();
  return results.map((row) =>
    toPerson({ user_id: row.id, displayName: row.display_name, ...(row.picture != null && { picture: row.picture }) }, row)
  );
}

export async function isKnownUser(db: D1Database, id: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 FROM users WHERE id = ?1').bind(id).first()) !== null;
}

export async function addFriend(db: D1Database, userId: string, friendId: string, now: Date = new Date()): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_on) VALUES (?1, ?2, ?3)')
    .bind(userId, friendId, now.toISOString())
    .run();
}

export async function removeFriend(db: D1Database, userId: string, friendId: string): Promise<void> {
  await db.prepare('DELETE FROM friends WHERE user_id = ?1 AND friend_id = ?2').bind(userId, friendId).run();
}
