// Deleting a player's account (DELETE /api/users/me), in an order that can be run again from the
// top if any step fails: the player is still signed in until the last step deletes them in Auth0.
//   1. Each unfinished match they're in: MatchDO's removeAccount gives their seat to a bot, or
//      drops a match with no other person left; the lobby rows follow.
//   2. Their rows in D1: their own stats, recent players and friends both ways, invites sent and
//      received, and push tokens.
//   3. Their users row becomes a tombstone (DELETED_NAME, no picture), so finished matches - kept
//      for the other players' history, where only their id is left - show a name.
//   4. Their Auth0 user: email, name, picture and settings.
import type { Env } from '../index';
import { deleteUser } from '../auth0Management';
import { deleteFromLobbyIndex, syncLobbyIndex } from '../lobby';

export const DELETED_NAME = 'Unknown';

export async function deleteAccount(env: Env, userId: string, now: Date = new Date()): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT m.id FROM match_players mp JOIN matches m ON m.id = mp.match_id
     WHERE mp.player_id = ?1 AND m.status = 'active'`
  )
    .bind(userId)
    .all<{ id: string }>();
  for (const { id } of results) {
    const result = await env.MATCH_DO.get(env.MATCH_DO.idFromName(id)).removeAccount(userId);
    if (!result.ok && result.status !== 404) {
      throw new Error(`Couldn't take ${userId} out of match ${id}: ${result.error.title}`);
    }
    if (!result.ok || result.value.deleted) await deleteFromLobbyIndex(env.DB, id);
    else await syncLobbyIndex(env.DB, result.value.match);
  }

  const at = now.toISOString();
  const db = env.DB;
  await db.batch([
    db.prepare('DELETE FROM player_match_stats WHERE player_id = ?1').bind(userId),
    db.prepare('DELETE FROM played_with WHERE user_id = ?1 OR other_id = ?1').bind(userId),
    db.prepare('DELETE FROM friends WHERE user_id = ?1 OR friend_id = ?1').bind(userId),
    db.prepare('DELETE FROM invites WHERE to_id = ?1 OR from_id = ?1').bind(userId),
    db.prepare('DELETE FROM push_tokens WHERE user_id = ?1').bind(userId),
    db
      .prepare(
        `INSERT INTO users (id, display_name, picture, updated_on, deleted_on) VALUES (?1, ?2, NULL, ?3, ?3)
         ON CONFLICT (id) DO UPDATE SET display_name = ?2, picture = NULL, updated_on = ?3, deleted_on = ?3`
      )
      .bind(userId, DELETED_NAME, at),
  ]);

  await deleteUser(env, userId);
}
