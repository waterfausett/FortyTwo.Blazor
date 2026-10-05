import { describe, it, expect, beforeAll } from 'vitest';
import { env, fetchMock, runInDurableObject } from 'cloudflare:test';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import { Positions } from '@fortytwo/rules';
import type { Env } from '../src/index';

const testEnv = env as unknown as Env;

// Must match the AUTH0_DOMAIN/AUTH0_AUDIENCE test-pool bindings in vitest.config.ts - the socket
// upgrade verifies its token against the (mocked) remote JWKS, as in matchDOSocket.test.ts.
const AUTH0_DOMAIN = 'test-tenant.auth0.local';
const AUTH0_AUDIENCE = 'https://api.test.local';
const KEY_ID = 'match-do-leave-test-key';

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
  fetchMock
    .get(`https://${AUTH0_DOMAIN}`)
    .intercept({ path: '/.well-known/jwks.json', method: 'GET' })
    .reply(200, JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } })
    .persist();
});

function signToken(sub: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setSubject(sub)
    .setIssuer(`https://${AUTH0_DOMAIN}/`)
    .setAudience(AUTH0_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}

// How many keys the DO still holds in storage - 0 once a match is deleted.
async function storedKeys(stub: ReturnType<typeof stubFor>): Promise<number> {
  return runInDurableObject(stub, async (_instance, state) => (await state.storage.list()).size);
}

describe('MatchDO leave', () => {
  it('removes a joiner and keeps the match', async () => {
    const stub = stubFor('leave-joiner');
    await stub.create('p1', 'leave-joiner');
    await stub.takeSeat('p2', Positions.Second);

    const result = await stub.leave('p2');

    if (!result.ok || result.value.deleted) throw new Error(`expected a kept match, got ${JSON.stringify(result)}`);
    expect(result.value.match.players.map((p) => p.playerId)).toEqual(['p1']);
    const reloaded = await stub.getMatch();
    expect(reloaded.ok && reloaded.value.players).toHaveLength(1);
  });

  it('deletes the match and wipes storage when the last human leaves', async () => {
    const stub = stubFor('leave-last-human');
    await stub.create('p1', 'leave-last-human');

    const result = await stub.leave('p1');

    expect(result).toEqual({ ok: true, value: { deleted: true } });
    expect(await stub.getMatch()).toMatchObject({ ok: false, status: 404 });
    expect(await storedKeys(stub)).toBe(0);
  });

  it('deletes a match left with only bots', async () => {
    const stub = stubFor('leave-bots-only');
    await stub.create('p1', 'leave-bots-only');
    await stub.takeSeat('bot-1', Positions.Second);

    expect(await stub.leave('p1')).toEqual({ ok: true, value: { deleted: true } });
  });

  it('refuses a non-player with a 400', async () => {
    const stub = stubFor('leave-outsider');
    await stub.create('p1', 'leave-outsider');

    expect(await stub.leave('p9')).toMatchObject({ ok: false, status: 400 });
  });

  it('is a 404 for a match that is already gone', async () => {
    expect(await stubFor('leave-never-created').leave('p1')).toMatchObject({ ok: false, status: 404 });
  });

  it('closes connected sockets with 4404 when the match is deleted', async () => {
    const stub = stubFor('leave-socket-close');
    await stub.create('p1', 'leave-socket-close');
    const res = await stub.fetch(`https://match-do/ws?token=${await signToken('p1')}`, {
      headers: { Upgrade: 'websocket' },
    });
    const ws = res.webSocket;
    if (!ws) {
      await res.text();
      throw new Error('expected a client WebSocket on the 101 response');
    }
    ws.accept();
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', (e) => resolve(e as CloseEvent)));

    await stub.leave('p1');

    expect((await closed).code).toBe(4404);
  });
});
