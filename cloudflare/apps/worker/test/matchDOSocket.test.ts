import { describe, it, expect, beforeAll } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import { Teams } from '@fortytwo/rules';
import type { Env } from '../src/index';

const testEnv = env as unknown as Env;

// Must match the AUTH0_DOMAIN/AUTH0_AUDIENCE bindings configured for the test pool in
// vitest.config.ts - MatchDO's handleWebSocketUpgrade calls verifyToken(token, this.env) with no
// injectable resolver, so it always resolves the real (here, mocked-via-fetchMock) remote JWKS.
const AUTH0_DOMAIN = 'test-tenant.auth0.local';
const AUTH0_AUDIENCE = 'https://api.test.local';
const ISSUER = `https://${AUTH0_DOMAIN}/`;
const KEY_ID = 'match-do-socket-test-key';

let privateKey: KeyLike;

beforeAll(async () => {
  const { publicKey, privateKey: generatedPrivateKey } = await generateKeyPair('RS256');
  privateKey = generatedPrivateKey;

  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = KEY_ID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  // MatchDO's upgrade handler fetches this JWKS document via jose's createRemoteJWKSet - mock it
  // so verifyToken() can actually validate a locally-signed test token without a real network call.
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

async function signToken(overrides: { sub?: string; audience?: string; issuer?: string } = {}) {
  const { sub = 'p1', audience = AUTH0_AUDIENCE, issuer = ISSUER } = overrides;

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

function stubFor(name: string) {
  const id = testEnv.MATCH_DO.idFromName(name);
  return testEnv.MATCH_DO.get(id);
}

// Mirrors matchDO.test.ts's rpc() helper: always fully consumes the response body before
// returning, even when the caller doesn't need it, per vitest-pool-workers' isolated-storage
// guidance - an unread Response body can leave a resource open across the test boundary.
async function rpc(
  stub: ReturnType<typeof stubFor>,
  method: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  const res = await stub.fetch(`https://match-do/rpc/${method}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

// Attempts a WebSocket upgrade and ALWAYS fully drains the resulting Response - either by
// accepting the returned client-side WebSocket (which owns the response going forward), or, when
// no WebSocket comes back (a rejected/not-yet-implemented upgrade), by reading its body as text.
// This must happen unconditionally, before any assertion that might throw, so a failing
// assertion (expected during RED) can never leave a Response body or socket dangling across the
// test boundary - exactly the unconsumed-resource EBUSY gotcha from Task 11.
async function openSocket(
  stub: ReturnType<typeof stubFor>,
  path: string
): Promise<{ status: number; ws: WebSocket | undefined }> {
  const res = await stub.fetch(`https://match-do${path}`, {
    headers: { Upgrade: 'websocket' },
  });
  const ws = res.webSocket ?? undefined;
  if (ws) {
    ws.accept();
  } else {
    await res.text();
  }
  return { status: res.status, ws };
}

describe('MatchDO WebSocket upgrade', () => {
  it('accepts a valid-token upgrade with a 101 response', async () => {
    const stub = stubFor('socket-valid-token');
    await rpc(stub, 'create', { firstPlayerId: 'p1' });
    const token = await signToken({ sub: 'p1' });

    const { status, ws } = await openSocket(stub, `/ws?token=${token}`);
    ws?.close();

    expect(status).toBe(101);
    expect(ws).toBeTruthy();
  });

  it('rejects an upgrade with no token as 401', async () => {
    const stub = stubFor('socket-missing-token');

    const { status, ws } = await openSocket(stub, '/ws');

    expect(status).toBe(401);
    expect(ws).toBeFalsy();
  });

  it('rejects an upgrade with an invalid token as 401', async () => {
    const stub = stubFor('socket-invalid-token');

    const { status, ws } = await openSocket(stub, '/ws?token=not-a-real-jwt');

    expect(status).toBe(401);
    expect(ws).toBeFalsy();
  });

  it('broadcasts a match message to a connected socket when an RPC method runs', async () => {
    const stub = stubFor('socket-broadcast');
    await rpc(stub, 'create', { firstPlayerId: 'p1' });
    const token = await signToken({ sub: 'p1' });

    const { status, ws } = await openSocket(stub, `/ws?token=${token}`);
    try {
      expect(status).toBe(101);
      if (!ws) throw new Error('expected a client WebSocket on the 101 response');

      const messagePromise = new Promise<MessageEvent>((resolve, reject) => {
        ws.addEventListener('message', (event) => resolve(event as MessageEvent), { once: true });
        ws.addEventListener('error', (event) => reject(event), { once: true });
      });

      const addPlayerResult = await rpc(stub, 'addPlayer', { playerId: 'p2', team: Teams.TeamA });
      expect(addPlayerResult.status).toBe(200);

      const event = await messagePromise;
      const payload = JSON.parse(event.data as string) as { type: string; match: { players: unknown[] } };

      expect(payload.type).toBe('match');
      expect(payload.match.players).toHaveLength(2);
    } finally {
      // Always close the client-side socket before the test ends - an unclosed WebSocket handle
      // is the same class of dangling-resource issue that caused Task 11's Windows EBUSY crash
      // with unread Response bodies.
      ws?.close();
    }
  });
});
