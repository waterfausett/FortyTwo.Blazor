// The Matchmaker's presence socket: tells each connected app how many players are online.
import { describe, it, expect, beforeAll } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
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

// Every count a socket receives, in order.
function received(ws: WebSocket): number[] {
  const counts: number[] = [];
  ws.addEventListener('message', (event) => counts.push(JSON.parse((event as MessageEvent).data as string).online));
  return counts;
}

async function openCounted(stub: DurableObjectStub, sub: string) {
  const res = await stub.fetch(`https://matchmaker/presence/ws?token=${await signToken({ sub })}`, {
    headers: { Upgrade: 'websocket' },
  });
  const ws = res.webSocket!;
  const counts = received(ws);
  ws.accept();
  return { ws, counts };
}

// Closes a socket and waits until the Matchmaker has let it go.
async function closeAndWait(stub: DurableObjectStub, ws: WebSocket, open: number) {
  ws.close();
  for (let i = 0; i < 100; i++) {
    if ((await runInDurableObject(stub, async (_i, state) => state.getWebSockets().length)) < open) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('socket never closed');
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

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

  it('skips the broadcast when a player leaves and comes back before it', async () => {
    const stub = testEnv.MATCHMAKER.get(testEnv.MATCHMAKER.idFromName('presence-repeat'));
    const a = await openCounted(stub, 'a');
    const b = await openCounted(stub, 'b');
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await settle();
    expect(a.counts.at(-1)).toBe(2);

    await closeAndWait(stub, b.ws, 2);
    const back = await openCounted(stub, 'b');
    await settle();
    const before = [...a.counts];
    expect(back.counts).toEqual([2]);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await settle();
    expect(a.counts).toEqual(before);
    expect(back.counts).toEqual([2]);
    for (const ws of [a.ws, back.ws]) ws.close();
  });

  it("still broadcasts when a newer socket was told a count the last broadcast didn't send", async () => {
    const stub = testEnv.MATCHMAKER.get(testEnv.MATCHMAKER.idFromName('presence-mixed'));
    const a = await openCounted(stub, 'a');
    const b = await openCounted(stub, 'b');
    await closeAndWait(stub, a.ws, 2);
    await settle();
    expect(b.counts).toEqual([2]);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await settle();
    expect(b.counts).toEqual([2, 1]);
    b.ws.close();
  });
});
