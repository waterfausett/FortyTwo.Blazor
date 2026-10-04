// MatchDO's `poke`: one poke per turn, delivered over the target's socket when they have the match
// open, else as a push - and not used up when it can't be delivered at all.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, fetchMock, runInDurableObject } from 'cloudflare:test';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import { Bid, createDomino, type Domino, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import { POKE_IDLE_MS } from '../src/poke';
import { saveToken } from '../src/push/tokens';

const testEnv = env as unknown as Env;

// The test pool's Auth0 bindings (vitest.config.ts); the JWKS is mocked below, as in
// matchDOSocket.test.ts.
const AUTH0_DOMAIN = 'test-tenant.auth0.local';
const KEY_ID = 'match-do-poke-test-key';
let privateKey: KeyLike;

beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  const publicJwk = { ...(await exportJWK(keys.publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' };
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get(`https://${AUTH0_DOMAIN}`)
    .intercept({ path: '/.well-known/jwks.json', method: 'GET' })
    .reply(200, JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } })
    .persist();
});

// D1 isn't reset between tests.
beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM push_tokens').run();
});

function signToken(sub: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setSubject(sub)
    .setIssuer(`https://${AUTH0_DOMAIN}/`)
    .setAudience('https://api.test.local')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

function deck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
  return dominoes;
}

// A DO named `name` holding a dealt match, p1-p4 seated.
async function dealtMatch(name: string) {
  const stub = testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
  await stub.create('p1', name);
  await stub.takeSeat('p2', 1);
  await stub.takeSeat('p3', 2);
  await stub.takeSeat('p4', 3, deck());
  return stub;
}

type Stub = Awaited<ReturnType<typeof dealtMatch>>;

// Winds the current turn's start back past the poke threshold, as if it had sat that long.
async function idle(stub: Stub): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const match = (await state.storage.get<MatchState>('match'))!;
    await state.storage.put('match', { ...match, updatedOn: new Date(Date.now() - POKE_IDLE_MS - 1000).toISOString() });
  });
}

// Who the table is waiting on, and someone else to poke them.
async function turnOf(stub: Stub): Promise<{ target: string; poker: string }> {
  const result = await stub.getMatch();
  if (!result.ok) throw new Error('expected a match');
  const target = result.value.currentGame.currentPlayerId!;
  return { target, poker: ['p1', 'p2', 'p3', 'p4'].find((id) => id !== target)! };
}

// Resolves with the messages the next request to Expo carries.
function expectPush(): Promise<{ to: string; title: string; priority: string; data: { url: string } }[]> {
  return new Promise((resolve) => {
    fetchMock
      .get('https://exp.host')
      .intercept({ path: '/--/api/v2/push/send', method: 'POST' })
      .reply((opts) => {
        const messages = JSON.parse(String(opts.body));
        resolve(messages);
        return { statusCode: 200, data: JSON.stringify({ data: messages.map(() => ({ status: 'ok', id: 't' })) }) };
      });
  });
}

describe('MatchDO poke', () => {
  it("refuses a turn that hasn't waited 30 minutes", async () => {
    const stub = await dealtMatch('poke-too-soon');
    const { poker } = await turnOf(stub);

    expect(await stub.poke(poker)).toMatchObject({ ok: false, status: 400, error: { title: 'Too soon to poke' } });
  });

  it('pushes to a target without the match open, once per turn', async () => {
    const stub = await dealtMatch('poke-push');
    const { target, poker } = await turnOf(stub);
    await saveToken(testEnv.DB, target, `ExponentPushToken[${target}]`, 'android');
    await idle(stub);

    const sent = expectPush();
    expect(await stub.poke(poker)).toEqual({ ok: true, value: { delivered: 'push' } });
    expect(await sent).toMatchObject([
      { to: `ExponentPushToken[${target}]`, title: "You've been poked", priority: 'high', data: { url: '/match/poke-push' } },
    ]);

    // Once per turn in total, not once per poker.
    const otherPoker = ['p1', 'p2', 'p3', 'p4'].find((id) => id !== target && id !== poker)!;
    expect(await stub.poke(otherPoker)).toMatchObject({ ok: false, status: 400, error: { title: 'Already poked' } });
  });

  it('nudges a target who has the match open over their socket only', async () => {
    const stub = await dealtMatch('poke-in-app');
    const { target, poker } = await turnOf(stub);
    await idle(stub);

    const open = async (sub: string) => {
      const res = await stub.fetch(`https://match-do/ws?token=${await signToken(sub)}`, { headers: { Upgrade: 'websocket' } });
      const ws = res.webSocket!;
      ws.accept();
      const messages: { type: string; from?: string }[] = [];
      ws.addEventListener('message', (event) => messages.push(JSON.parse((event as MessageEvent).data as string)));
      return { ws, messages };
    };
    const targetSocket = await open(target);
    const pokerSocket = await open(poker);
    try {
      const poked = new Promise<void>((resolve) =>
        targetSocket.ws.addEventListener('message', (event) => {
          if (JSON.parse((event as MessageEvent).data as string).type === 'poke') resolve();
        })
      );

      expect(await stub.poke(poker)).toEqual({ ok: true, value: { delivered: 'inApp' } });
      await poked;
      expect(targetSocket.messages.filter((m) => m.type === 'poke')).toEqual([{ type: 'poke', from: poker }]);
      expect(pokerSocket.messages.some((m) => m.type === 'poke')).toBe(false);
    } finally {
      targetSocket.ws.close();
      pokerSocket.ws.close();
    }
  });

  it("says when the poke can't reach the target, and doesn't use up the turn's poke", async () => {
    const stub = await dealtMatch('poke-none');
    const { target, poker } = await turnOf(stub);
    await idle(stub);

    expect(await stub.poke(poker)).toEqual({ ok: true, value: { delivered: 'none' } });

    await saveToken(testEnv.DB, target, `ExponentPushToken[${target}]`, 'ios');
    const sent = expectPush();
    expect(await stub.poke(poker)).toEqual({ ok: true, value: { delivered: 'push' } });
    await sent;
  });

  it('lets the next turn be poked again', async () => {
    const stub = await dealtMatch('poke-next-turn');
    const first = await turnOf(stub);
    for (const id of ['p1', 'p2', 'p3', 'p4']) await saveToken(testEnv.DB, id, `ExponentPushToken[${id}]`, 'android');
    await idle(stub);
    let sent = expectPush();
    expect(await stub.poke(first.poker)).toMatchObject({ ok: true });
    await sent;

    // The bid moves the turn on, which sends the next player their own turn notice.
    sent = expectPush();
    await stub.bid(first.target, Bid.Pass);
    await sent;
    const second = await turnOf(stub);
    await idle(stub);
    sent = expectPush();
    expect(await stub.poke(second.poker)).toEqual({ ok: true, value: { delivered: 'push' } });
    expect((await sent).map((m) => m.to)).toEqual([`ExponentPushToken[${second.target}]`]);
  });
});
