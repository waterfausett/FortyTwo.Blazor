// The Matchmaker's presence socket: tells each connected app how many players are online.
import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { fetchMock } from './fetchMock';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import type { Env } from '../src/index';

const testEnv = env as unknown as Env;

// Must match the AUTH0_DOMAIN/AUTH0_AUDIENCE bindings configured for the test pool in
// vitest.config.ts - the upgrade handler calls verifyToken(token, this.env) with no injectable
// resolver, so it always resolves the real (here, mocked-via-fetchMock) remote JWKS.
const AUTH0_DOMAIN = 'test-tenant.auth0.local';
const AUTH0_AUDIENCE = 'https://api.test.local';
const ISSUER = `https://${AUTH0_DOMAIN}/`;
const KEY_ID = 'matchmaker-presence-test-key';

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

async function signToken(overrides: { sub?: string } = {}) {
  const { sub = 'p1' } = overrides;

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUTH0_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

// Attempts a WebSocket upgrade and ALWAYS fully drains the resulting Response - either by
// accepting the returned client-side WebSocket (which owns the response going forward), or, when
// no WebSocket comes back (a rejected upgrade), by reading its body as text. This must happen
// unconditionally, before any assertion that might throw, so a failing assertion can never leave a
// Response body or socket dangling across the test boundary - vitest-plugin's isolated
// storage then fails to tear down (EBUSY on Windows).
async function openSocket(
  stub: DurableObjectStub,
  path: string
): Promise<{ status: number; ws: WebSocket | undefined }> {
  const res = await stub.fetch(`https://matchmaker${path}`, {
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

function firstMessage(ws: WebSocket): Promise<{ type: string; online: number }> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('message', (event) => resolve(JSON.parse((event as MessageEvent).data as string)), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
}

describe('Matchmaker presence sockets', () => {
  it('tells a new socket how many players are online, counting each player once', async () => {
    const stub = testEnv.MATCHMAKER.get(testEnv.MATCHMAKER.idFromName('presence-count'));
    const a = await openSocket(stub, `/presence/ws?token=${await signToken({ sub: 'a' })}`);
    const a2 = await openSocket(stub, `/presence/ws?token=${await signToken({ sub: 'a' })}`);
    const bToken = await signToken({ sub: 'b' });
    const res = await stub.fetch(`https://matchmaker/presence/ws?token=${bToken}`, { headers: { Upgrade: 'websocket' } });
    const b = res.webSocket!;
    const first = firstMessage(b);
    b.accept();

    expect(await first).toEqual({ type: 'online', online: 2 });
    for (const ws of [a.ws, a2.ws, b]) ws?.close();
  });

  it('refuses a socket without a valid token', async () => {
    const stub = testEnv.MATCHMAKER.get(testEnv.MATCHMAKER.idFromName('presence-auth'));
    const { status } = await openSocket(stub, '/presence/ws?token=nope');
    expect(status).toBe(401);
  });
});
