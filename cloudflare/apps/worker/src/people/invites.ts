// The invites table (migrations/0012_people.sql): invites to a custom table, sent from the table
// (POST /api/matches/:id/invites) and listed in the invitee's Lobby (GET /api/invites). An invite
// reserves nothing - custom tables stay open to anyone (#84 would change that). It's deleted when
// the invitee sits or the table fills (lobby.ts's syncMatchPlayers) or goes (deleteFromLobbyIndex),
// and the list also hides any to a table that's no longer open, in case that cleanup was missed.
import type { Invite, PublicUser } from '@fortytwo/api-types';
import { isBot, type MatchState } from '@fortytwo/rules';
import type { Env } from '../index';
import { publicUsers } from '../users/publicUsers';

export const MAX_INVITES_PER_TABLE = 6;
const INVITES_LIMIT = 20;

// Stores invites to `toIds`, leaving out anyone seated, bots, the inviter, ids the users table
// doesn't know, and anyone already invited to this table (dismissed or not). Returns who was
// invited, or 'tooMany' if they'd take the table past MAX_INVITES_PER_TABLE.
export async function createInvites(
  db: D1Database,
  match: MatchState,
  fromId: string,
  toIds: string[],
  now: Date = new Date()
): Promise<string[] | 'tooMany'> {
  const seated = new Set(match.players.map((p) => p.playerId));
  const candidates = toIds.filter((id) => !seated.has(id) && !isBot(id) && id !== fromId);
  const { results: existing } = await db
    .prepare('SELECT to_id FROM invites WHERE match_id = ?1')
    .bind(match.id)
    .all<{ to_id: string }>();
  const already = new Set(existing.map((r) => r.to_id));
  const fresh = candidates.filter((id) => !already.has(id));
  if (fresh.length === 0) return [];
  const placeholders = fresh.map((_, i) => `?${i + 1}`).join(', ');
  const { results: known } = await db
    .prepare(`SELECT id FROM users WHERE id IN (${placeholders})`)
    .bind(...fresh)
    .all<{ id: string }>();
  const knownIds = new Set(known.map((r) => r.id));
  const invited = fresh.filter((id) => knownIds.has(id));
  if (invited.length === 0) return [];
  if (existing.length + invited.length > MAX_INVITES_PER_TABLE) return 'tooMany';
  await db.batch(
    invited.map((id) =>
      db
        .prepare('INSERT OR IGNORE INTO invites (match_id, to_id, from_id, created_on) VALUES (?1, ?2, ?3, ?4)')
        .bind(match.id, id, fromId, now.toISOString())
    )
  );
  return invited;
}

export async function listInvites(env: Env, userId: string): Promise<Invite[]> {
  const { results } = await env.DB.prepare(
    `SELECT i.match_id, i.from_id, i.created_on, m.player_count
     FROM invites i JOIN matches m ON m.id = i.match_id
     WHERE i.to_id = ?1 AND i.dismissed = 0 AND m.status = 'active' AND m.player_count < 4
     ORDER BY i.created_on DESC LIMIT ${INVITES_LIMIT}`
  )
    .bind(userId)
    .all<{ match_id: string; from_id: string; created_on: string; player_count: number }>();
  if (results.length === 0) return [];
  const { users } = await publicUsers(env, results.map((r) => r.from_id));
  const byId = new Map(users.map((u) => [u.user_id, u]));
  return results.map((r) => ({
    matchId: r.match_id,
    from: byId.get(r.from_id) ?? ({ user_id: r.from_id, displayName: 'A player' } satisfies PublicUser),
    createdOn: r.created_on,
    seatsOpen: 4 - r.player_count,
  }));
}

// Kept, marked dismissed, so the table can't send it again.
export async function dismissInvite(db: D1Database, userId: string, matchId: string): Promise<void> {
  await db.prepare('UPDATE invites SET dismissed = 1 WHERE match_id = ?1 AND to_id = ?2').bind(matchId, userId).run();
}
