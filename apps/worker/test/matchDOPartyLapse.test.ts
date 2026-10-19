// At the end of a Live game, a player who leaves the screen has 30 s to come back before their
// party offer and rematch vote lapse (they're marked away). Daily rematch votes never lapse.
import { describe, it, expect, beforeAll } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { fetchMock } from './fetchMock';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import { PARTY_GRACE_MS, createDomino, type MatchMode, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import type { MatchDO } from '../src/matchDO';
import { finishedMatch } from './finishedMatch';
import { almostWonMatch } from './almostWonMatch';

const testEnv = env as unknown as Env;

// Must match the AUTH0_DOMAIN/AUTH0_AUDIENCE bindings configured for the test pool in
// vitest.config.ts (see matchDOSocket.test.ts).
const AUTH0_DOMAIN = 'test-tenant.auth0.local';
const AUTH0_AUDIENCE = 'https://api.test.local';
const ISSUER = `https://${AUTH0_DOMAIN}/`;
const KEY_ID = 'match-do-party-lapse-test-key';

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

async function signToken(sub: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUTH0_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}

function valueOf<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error(`expected an ok result, got ${JSON.stringify(result)}`);
  return result.value;
}

// Opens a socket as `sub` and waits for its first message (the current match). Always drains the
// response, so nothing dangles across the test boundary (see matchDOSocket.test.ts's openSocket).
async function openSocket(stub: ReturnType<typeof stubFor>, sub: string): Promise<WebSocket> {
  const res = await stub.fetch(`https://match-do/ws?token=${await signToken(sub)}`, {
    headers: { Upgrade: 'websocket' },
  });
  const ws = res.webSocket;
  if (!ws) {
    await res.text();
    throw new Error(`expected a WebSocket, got ${res.status}`);
  }
  const first = new Promise<void>((resolve) => ws.addEventListener('message', () => resolve(), { once: true }));
  ws.accept();
  await first;
  return ws;
}

async function seed(name: string, match: MatchState) {
  const stub = stubFor(name);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('match', match);
  });
  return stub;
}

// A finished match where p1 has offered to party up and voted to rematch.
function finished(name: string, mode: MatchMode, extra: Partial<MatchState> = {}): MatchState {
  return { ...finishedMatch(name), mode, partyOffers: ['p1'], rematchVotes: ['p1'], ...extra };
}

// `playerId` opens the match and leaves it again: their only socket closes, and the runtime tells
// the DO (webSocketClose) a moment later, so this waits for the lapse it starts.
async function openAndLeave(stub: ReturnType<typeof stubFor>, playerId: string) {
  const ws = await openSocket(stub, playerId);
  ws.close();
  for (let i = 0; i < 100 && (await lapsesOf(stub))?.[playerId] === undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// webSocketClose for `playerId`'s only socket, called directly: for a match where it must start
// nothing, since there's no lapse to wait for.
async function closeLastSocket(stub: ReturnType<typeof stubFor>, playerId: string) {
  await runInDurableObject(stub, async (instance, state) => {
    const pair = new WebSocketPair();
    state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ playerId });
    await (instance as unknown as MatchDO).webSocketClose(pair[1], 1000, '', true);
  });
}

async function lapsesOf(stub: ReturnType<typeof stubFor>) {
  return runInDurableObject(stub, (_instance, state) => state.storage.get<Record<string, number>>('lapses'));
}

// Brings every pending lapse due now, as if the grace period had run out.
async function makeLapsesDue(stub: ReturnType<typeof stubFor>) {
  await runInDurableObject(stub, async (_instance, state) => {
    const lapses = (await state.storage.get<Record<string, number>>('lapses')) ?? {};
    for (const id of Object.keys(lapses)) lapses[id] = Date.now() - 1;
    await state.storage.put('lapses', lapses);
  });
}

describe('MatchDO party lapses', () => {
  it("marks a player away, offer and vote gone, once they've been off the screen for the grace period", async () => {
    const stub = await seed('lapse-close', finished('lapse-close', 'live'));

    const before = Date.now();
    await openAndLeave(stub, 'p1');
    const lapses = await lapsesOf(stub);
    expect(lapses?.p1).toBeGreaterThanOrEqual(before + PARTY_GRACE_MS);
    expect(lapses?.p1).toBeLessThanOrEqual(Date.now() + PARTY_GRACE_MS);

    await makeLapsesDue(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const after = valueOf(await stub.getMatch());
    expect(after.away).toEqual(['p1']);
    expect(after.partyOffers ?? []).toEqual([]);
    expect(after.rematchVotes ?? []).toEqual([]);
    expect(await lapsesOf(stub)).toEqual({});
  });

  it('keeps the offer of a player who comes back before the grace period runs out', async () => {
    const stub = await seed('lapse-back', finished('lapse-back', 'live'));
    await openAndLeave(stub, 'p1');
    expect((await lapsesOf(stub))?.p1).toBeDefined();

    const ws = await openSocket(stub, 'p1');
    try {
      expect((await lapsesOf(stub))?.p1).toBeUndefined();
      await runDurableObjectAlarm(stub);

      const after = valueOf(await stub.getMatch());
      expect(after.away).toBeUndefined();
      expect(after.partyOffers).toEqual(['p1']);
    } finally {
      ws.close();
    }
  });

  it('is no longer away once they open the game again', async () => {
    const stub = await seed('lapse-return', finished('lapse-return', 'live', { away: ['p1'], partyOffers: [], rematchVotes: [] }));

    const ws = await openSocket(stub, 'p1');
    try {
      expect(valueOf(await stub.getMatch()).away).toEqual([]);
    } finally {
      ws.close();
    }
  });

  it('starts a lapse for each player not on the screen when a Live match is won', async () => {
    const stub = await seed('lapse-won', { ...almostWonMatch('lapse-won'), mode: 'live' });
    const ws = await openSocket(stub, 'p1');
    try {
      // p4 makes the winning play, and p1 is watching; p2 and p3 aren't on the screen.
      const result = valueOf(await stub.playDomino('p4', createDomino(1, 3)));
      expect(result.winningTeam).not.toBeNull();

      expect(Object.keys((await lapsesOf(stub)) ?? {}).sort()).toEqual(['p2', 'p3']);
    } finally {
      ws.close();
    }
  });

  it('never lapses a Daily match', async () => {
    const stub = await seed('lapse-daily', finished('lapse-daily', 'daily'));

    await closeLastSocket(stub, 'p1');

    expect(await lapsesOf(stub)).toBeUndefined();
  });
});
