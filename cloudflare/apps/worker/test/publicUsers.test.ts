// users/publicUsers.ts against the test D1 (migrations applied by applyMigrations.ts). The Auth0
// paths are covered through the routes in routes.users.test.ts.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index';
import { publicUsers, saveUsers } from '../src/users/publicUsers';

const testEnv = env as unknown as Env;

async function row(id: string) {
  return testEnv.DB.prepare('SELECT display_name, picture, updated_on FROM users WHERE id = ?1')
    .bind(id)
    .first<{ display_name: string; picture: string | null; updated_on: string }>();
}

describe('saveUsers', () => {
  it('stores a player, and rewrites the row only when their name or picture changed', async () => {
    const first = new Date('2026-10-01T00:00:00.000Z');
    const later = new Date('2026-10-02T00:00:00.000Z');
    await saveUsers(testEnv.DB, [{ user_id: 'auth0|a', displayName: 'Amy', picture: 'a.png' }], first);
    expect(await row('auth0|a')).toEqual({ display_name: 'Amy', picture: 'a.png', updated_on: first.toISOString() });

    await saveUsers(testEnv.DB, [{ user_id: 'auth0|a', displayName: 'Amy', picture: 'a.png' }], later);
    expect((await row('auth0|a'))?.updated_on).toBe(first.toISOString());

    await saveUsers(testEnv.DB, [{ user_id: 'auth0|a', displayName: 'Amelia', picture: 'a.png' }], later);
    expect(await row('auth0|a')).toEqual({ display_name: 'Amelia', picture: 'a.png', updated_on: later.toISOString() });

    await saveUsers(testEnv.DB, [{ user_id: 'auth0|a', displayName: 'Amelia' }], first);
    expect(await row('auth0|a')).toEqual({ display_name: 'Amelia', picture: null, updated_on: first.toISOString() });
  });
});

describe('publicUsers', () => {
  it('reads stored players from D1 and names bots, without asking Auth0', async () => {
    // fetchMock isn't active in this file, so an Auth0 call would fail and leave auth0|b out.
    await saveUsers(testEnv.DB, [{ user_id: 'auth0|b', displayName: 'Bea', picture: 'b.png' }]);
    const found = await publicUsers(testEnv, ['auth0|b', 'bot-2', 'auth0|b']);
    expect(found).toEqual(
      expect.arrayContaining([
        { user_id: 'auth0|b', displayName: 'Bea', picture: 'b.png' },
        { user_id: 'bot-2', displayName: 'Bot 2' },
      ])
    );
    expect(found).toHaveLength(2);
  });

  it('returns what it has when Auth0 cannot be reached', async () => {
    await saveUsers(testEnv.DB, [{ user_id: 'auth0|c', displayName: 'Cy' }]);
    expect(await publicUsers(testEnv, ['auth0|c', 'auth0|nobody'])).toEqual([{ user_id: 'auth0|c', displayName: 'Cy' }]);
  });
});
