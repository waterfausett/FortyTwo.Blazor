// The Worker's WebSocket route (`/matches/:id/ws`), through the REAL Worker (`SELF.fetch`).
// matchDOSocket.test.ts connects straight to the DO stub, so it can't catch the Worker failing to
// route an upgrade to MatchDO at all - which it once did, 404ing every real connection.
import { describe, it, expect, beforeAll } from 'vitest';
import { env, fetchMock, SELF } from 'cloudflare:test';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import type { Env } from '../src/index';

const testEnv = env as unknown as Env;

const AUTH0_DOMAIN = 'test-tenant.auth0.local';
const AUTH0_AUDIENCE = 'https://api.test.local';
const ISSUER = `https://${AUTH0_DOMAIN}/`;
const KEY_ID = 'ws-route-test-key';

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
    .reply(200, JSON.stringify({ keys: [publicJwk] }), {
      headers: { 'content-type': 'application/json' },
    })
    .persist();
});

async function signToken(sub: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUTH0_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

describe('Worker /matches/:id/ws route', () => {
  it('routes a real WebSocket upgrade through the Worker to the MatchDO, returning 101', async () => {
    const token = await signToken('ws-route-p1');

    // Create the match through the REST layer first (mirrors real client flow: create, then
    // connect) so the DO addressed by this id actually exists.
    const createRes = await SELF.fetch('https://example.com/api/matches', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    const upgradeRes = await SELF.fetch(
      `https://example.com/matches/${created.id}/ws?token=${token}`,
      { headers: { Upgrade: 'websocket' } }
    );

    expect(upgradeRes.status).toBe(101);
    const ws = upgradeRes.webSocket;
    expect(ws).toBeTruthy();
    // Mirrors matchDOSocket.test.ts's openSocket helper: the client-side WebSocket must be
    // accept()-ed before it can be used/closed, or vitest-pool-workers' isolated-storage teardown
    // fails with a dangling-resource EBUSY error across the test boundary.
    ws?.accept();
    ws?.close();
  });

  it('rejects a non-upgrade request to the ws route with 426', async () => {
    const token = await signToken('ws-route-p2');

    const res = await SELF.fetch(`https://example.com/matches/some-id/ws?token=${token}`);
    // No WebSocket comes back for a rejected upgrade - fully drain the body (mirrors
    // matchDOSocket.test.ts's openSocket helper) so isolated-storage teardown doesn't see a
    // dangling resource across the test boundary.
    await res.text();

    expect(res.status).toBe(426);
  });

  it('is unaffected by requireAuth (mounted outside /api/*): a missing token still reaches the DO, which rejects with 401', async () => {
    const res = await SELF.fetch('https://example.com/matches/some-id/ws', {
      headers: { Upgrade: 'websocket' },
    });
    await res.text();

    // No `Authorization` header is sent (a real WS upgrade can't carry one) - if this route were
    // mistakenly behind requireAuth, Hono would reject BEFORE reaching the DO. Getting 401 here
    // (matchDO.ts's own "Missing token" check) rather than some auth-middleware-shaped error
    // confirms the request reached MatchDO's own upgrade handler.
    expect(res.status).toBe(401);
  });
});
