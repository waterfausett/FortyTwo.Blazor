// Account deletion (DELETE /api/users/me, users/deleteAccount.ts) through the real Worker, with
// Auth0 mocked: unfinished matches hand the seat on or are dropped, finished ones are kept, the
// player's D1 rows go (other players' stay), the users row becomes a tombstone, and Auth0 is asked
// to delete them last - so a failure there leaves everything else done and the request retryable.
import { describe, it, expect, beforeAll } from 'vitest';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import { fetchMock } from './fetchMock';
import { Teams, createDomino, isBot, type Domino, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import { syncLobbyIndex } from '../src/lobby';
import { saveUsers } from '../src/users/publicUsers';
import { DELETED_NAME } from '../src/users/deleteAccount';

const testEnv = env as unknown as Env;

// Must match the AUTH0_DOMAIN/AUTH0_AUDIENCE test-pool bindings in vitest.config.ts, as in
// routes.users.test.ts.
const AUTH0_DOMAIN = 'test-tenant.auth0.local';
const AUTH0_AUDIENCE = 'https://api.test.local';
const KEY_ID = 'delete-account-test-key';

let privateKey: KeyLike;

beforeAll(async () => {
  const { publicKey, privateKey: generatedPrivateKey } = await generateKeyPair('RS256');
  privateKey = generatedPrivateKey;
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = KEY_ID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  fetchMock.activate();
  fetchMock.disableNetConnect();
  const auth0 = fetchMock.get(`https://${AUTH0_DOMAIN}`);
  auth0
    .intercept({ path: '/.well-known/jwks.json', method: 'GET' })
    .reply(200, JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } })
    .persist();
  auth0
    .intercept({ path: '/oauth/token', method: 'POST' })
    .reply(200, JSON.stringify({ access_token: 'mgmt-token', expires_in: 3600, token_type: 'Bearer' }), {
      headers: { 'content-type': 'application/json' },
    })
    .persist();
});

async function api(path: string, sub: string, init: RequestInit = {}): Promise<Response> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setSubject(sub)
    .setIssuer(`https://${AUTH0_DOMAIN}/`)
    .setAudience(AUTH0_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  return SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), Authorization: `Bearer ${token}` },
  });
}

const deleteMe = (sub: string) => api('/api/users/me', sub, { method: 'DELETE' });

// Answers the next Auth0 user DELETE with `status`, recording the path it was sent to.
function mockUserDelete(status = 204): { path?: string } {
  const seen: { path?: string } = {};
  fetchMock
    .get(`https://${AUTH0_DOMAIN}`)
    .intercept({ path: (path: string) => path.startsWith('/api/v2/users/'), method: 'DELETE' })
    .reply(({ path }) => {
      seen.path = path;
      return { statusCode: status };
    });
  return seen;
}

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}
type Stub = ReturnType<typeof stubFor>;

async function stored(stub: Stub): Promise<MatchState | undefined> {
  return runInDurableObject(stub, async (_instance, state) => state.storage.get<MatchState>('match'));
}

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// A match `first` made, with `others` seated after them (the 4th dealing), listed in the lobby.
async function seatedMatch(name: string, mode: 'custom' | 'daily', first: string, others: string[]): Promise<Stub> {
  const stub = stubFor(name);
  await stub.create(first, name, mode);
  for (const [i, id] of others.entries()) await stub.takeSeat(id, i + 1, deck());
  await syncLobbyIndex(testEnv.DB, (await stored(stub))!);
  return stub;
}

async function seatRows(matchId: string): Promise<string[]> {
  const { results } = await testEnv.DB.prepare('SELECT player_id FROM match_players WHERE match_id = ?1 ORDER BY player_id')
    .bind(matchId)
    .all<{ player_id: string }>();
  return results.map((r) => r.player_id);
}

async function count(sql: string, ...binds: string[]): Promise<number> {
  return (await testEnv.DB.prepare(sql).bind(...binds).first<number>('n')) ?? 0;
}

// A player_match_stats row with every count zeroed.
function statsRow(matchId: string, playerId: string, partnerId: string) {
  const zeros = Array(17).fill(0).join(', ');
  return testEnv.DB.prepare(
    `INSERT INTO player_match_stats (match_id, player_id, partner_id, with_bots, won, marks_won, bids_won, bids_made,
       points_bid_total, points_bid_count, marks_bids, trump_low, trump_follow_me, trump_blanks, trump_aces, trump_deuces,
       trump_threes, trump_fours, trump_fives, trump_sixes, completed_on)
     VALUES (?1, ?2, ?3, ${zeros}, '2026-10-01T00:00:00.000Z')`
  ).bind(matchId, playerId, partnerId);
}

describe('DELETE /api/users/me', () => {
  it("deletes the caller's rows both ways, keeps everyone else's, and deletes them in Auth0", async () => {
    const me = 'auth0|del-rows';
    const db = testEnv.DB;
    const at = '2026-10-01T00:00:00.000Z';
    await saveUsers(db, [
      { user_id: me, displayName: 'Delia', picture: 'https://example.com/d.png' },
      { user_id: 'auth0|del-rows-other', displayName: 'Otto' },
    ]);
    await db.batch([
      statsRow('del-rows-m1', me, 'auth0|del-rows-other'),
      statsRow('del-rows-m1', 'auth0|del-rows-other', me),
      db.prepare('INSERT INTO played_with (user_id, other_id, last_played_on) VALUES (?1, ?2, ?3), (?2, ?1, ?3), (?2, ?4, ?3)')
        .bind(me, 'auth0|del-rows-other', at, 'auth0|del-rows-third'),
      db.prepare('INSERT INTO friends (user_id, friend_id, created_on) VALUES (?1, ?2, ?3), (?2, ?1, ?3)').bind(me, 'auth0|del-rows-other', at),
      db.prepare('INSERT INTO invites (match_id, to_id, from_id, created_on) VALUES (?4, ?1, ?2, ?3), (?5, ?2, ?1, ?3), (?6, ?2, ?7, ?3)')
        .bind(me, 'auth0|del-rows-other', at, 'del-rows-i1', 'del-rows-i2', 'del-rows-i3', 'auth0|del-rows-third'),
      db.prepare("INSERT INTO push_tokens (token, user_id, platform, updated_on) VALUES ('ExponentPushToken[del-rows]', ?1, 'android', ?2)").bind(me, at),
    ]);
    const auth0 = mockUserDelete();

    const res = await deleteMe(me);

    expect(res.status).toBe(204);
    expect(auth0.path).toBe(`/api/v2/users/${encodeURIComponent(me)}`);
    expect(await count('SELECT COUNT(*) AS n FROM player_match_stats WHERE player_id = ?1', me)).toBe(0);
    // The other player's own stats stay, still naming the deleted player as partner (an id, no name).
    expect(await count('SELECT COUNT(*) AS n FROM player_match_stats WHERE player_id = ?1', 'auth0|del-rows-other')).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM played_with WHERE user_id = ?1 OR other_id = ?1', me)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM played_with WHERE user_id = ?1', 'auth0|del-rows-other')).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM friends WHERE user_id = ?1 OR friend_id = ?1', me)).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM invites WHERE to_id = ?1 OR from_id = ?1', me)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM invites WHERE match_id = 'del-rows-i3'")).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM push_tokens WHERE user_id = ?1', me)).toBe(0);
    const row = await db.prepare('SELECT display_name, picture, deleted_on FROM users WHERE id = ?1').bind(me)
      .first<{ display_name: string; picture: string | null; deleted_on: string | null }>();
    expect(row).toMatchObject({ display_name: DELETED_NAME, picture: null });
    expect(row?.deleted_on).not.toBeNull();
  });

  it("shows the deleted player by the tombstone's name and leaves them out of people search", async () => {
    const me = 'auth0|del-search';
    await saveUsers(testEnv.DB, [{ user_id: me, displayName: 'Searchable Sam' }]);
    mockUserDelete();
    expect((await deleteMe(me)).status).toBe(204);

    const names = await api('/api/users/search', 'auth0|del-search-viewer', {
      method: 'POST',
      body: JSON.stringify([me]),
    });
    expect(await names.json()).toEqual([{ user_id: me, displayName: DELETED_NAME }]);
    for (const q of ['Searchable', DELETED_NAME]) {
      const found = (await (await api(`/api/people/search?q=${q}`, 'auth0|del-search-viewer')).json()) as { user_id: string }[];
      expect(found.map((p) => p.user_id)).not.toContain(me);
    }
  });

  it('takes the player out of a Custom match before the deal, keeping it for the others', async () => {
    const me = 'auth0|del-predeal';
    const stub = await seatedMatch('del-predeal', 'custom', 'p1', [me]);
    mockUserDelete();

    expect((await deleteMe(me)).status).toBe(204);

    expect((await stored(stub))!.players.map((p) => p.playerId)).toEqual(['p1']);
    expect(await seatRows('del-predeal')).toEqual(['p1']);
  });

  it('gives a bot their seat for good in an Async game under way', async () => {
    const me = 'auth0|del-daily';
    const stub = await seatedMatch('del-daily', 'daily', 'p1', [me, 'p3', 'p4']);
    mockUserDelete();

    expect((await deleteMe(me)).status).toBe(204);

    const match = (await stored(stub))!;
    const seat = match.players.find((p) => p.position === 1)!;
    expect(isBot(seat.playerId)).toBe(true);
    expect(match.players.map((p) => p.playerId)).not.toContain(me);
    expect(JSON.stringify(match.currentGame)).not.toContain(me);
    expect(await seatRows('del-daily')).not.toContain(me);
  });

  it('drops an Async game under way when nobody else is a person', async () => {
    const me = 'auth0|del-daily-alone';
    await seatedMatch('del-daily-alone', 'daily', me, ['bot-1', 'bot-2', 'bot-3']);
    mockUserDelete();

    expect((await deleteMe(me)).status).toBe(204);

    expect(await stored(stubFor('del-daily-alone'))).toBeUndefined();
    expect(await count("SELECT COUNT(*) AS n FROM matches WHERE id = 'del-daily-alone'")).toBe(0);
    expect(await seatRows('del-daily-alone')).toEqual([]);
  });

  it('keeps a finished match, with the player still in it, for the others', async () => {
    const me = 'auth0|del-finished';
    const stub = await seatedMatch('del-finished', 'custom', me, ['p2', 'p3', 'p4']);
    await runInDurableObject(stub, async (_i, state) => {
      const m = (await state.storage.get<MatchState>('match'))!;
      await state.storage.put('match', { ...m, winningTeam: Teams.TeamA });
    });
    mockUserDelete();

    expect((await deleteMe(me)).status).toBe(204);

    expect((await stored(stub))!.players.map((p) => p.playerId)).toContain(me);
  });

  it('is a 500 when Auth0 refuses, with the rest done, and can be retried', async () => {
    const me = 'auth0|del-retry';
    const stub = await seatedMatch('del-retry', 'daily', 'p1', [me, 'p3', 'p4']);
    await testEnv.DB.prepare("INSERT INTO push_tokens (token, user_id, platform, updated_on) VALUES ('ExponentPushToken[del-retry]', ?1, 'android', ?2)")
      .bind(me, '2026-10-01T00:00:00.000Z')
      .run();
    mockUserDelete(403);

    expect((await deleteMe(me)).status).toBe(500);
    expect(await count('SELECT COUNT(*) AS n FROM push_tokens WHERE user_id = ?1', me)).toBe(0);
    const afterFirst = (await stored(stub))!.players.map((p) => p.playerId);
    expect(afterFirst).not.toContain(me);

    const auth0 = mockUserDelete();
    expect((await deleteMe(me)).status).toBe(204);
    expect(auth0.path).toBe(`/api/v2/users/${encodeURIComponent(me)}`);
    // The second run found nothing left to hand on.
    expect((await stored(stub))!.players.map((p) => p.playerId)).toEqual(afterFirst);
  });
});

describe('saveUsers after deletion', () => {
  it('brings a tombstone back when the same id signs up again', async () => {
    const me = 'google-oauth2|del-revive';
    await saveUsers(testEnv.DB, [{ user_id: me, displayName: 'Rae' }]);
    mockUserDelete();
    expect((await deleteMe(me)).status).toBe(204);

    await saveUsers(testEnv.DB, [{ user_id: me, displayName: 'Rae' }]);

    const row = await testEnv.DB.prepare('SELECT display_name, deleted_on FROM users WHERE id = ?1').bind(me).first();
    expect(row).toEqual({ display_name: 'Rae', deleted_on: null });
  });
});
