import { describe, it, expect, beforeAll, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { fetchMock } from './fetchMock';
import { SignJWT, generateKeyPair, exportJWK, type KeyLike } from 'jose';
import { Teams, createDomino, type Domino } from '@fortytwo/rules';
import type { Env } from '../src/index';
import { saveToken } from '../src/push/tokens';
import type { MatchDO } from '../src/matchDO';
import { finishedMatch } from './finishedMatch';

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

// A DO named `name` holding a new match created by p1.
async function createdBy(name: string, firstPlayerId = 'p1') {
  const stub = stubFor(name);
  await stub.create(firstPlayerId, name);
  return stub;
}

// Attempts a WebSocket upgrade and ALWAYS fully drains the resulting Response - either by
// accepting the returned client-side WebSocket (which owns the response going forward), or, when
// no WebSocket comes back (a rejected upgrade), by reading its body as text. This must happen
// unconditionally, before any assertion that might throw, so a failing assertion can never leave a
// Response body or socket dangling across the test boundary - vitest-plugin's isolated
// storage then fails to tear down (EBUSY on Windows).
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
    const stub = await createdBy('socket-valid-token');
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

  // A client that connects and then does nothing (the creator waiting for others to join, anyone
  // reconnecting mid-game) must still get the match - otherwise it waits on a spinner until the
  // next change. The very first message after the upgrade carries the current state.
  it('sends the current match state to a newly-connected socket immediately, with no RPC call needed', async () => {
    const stub = await createdBy('socket-initial-state');
    const token = await signToken({ sub: 'p1' });

    const res = await stub.fetch('https://match-do/ws?token=' + token, {
      headers: { Upgrade: 'websocket' },
    });
    const ws = res.webSocket;
    if (!ws) {
      await res.text();
      throw new Error('expected a client WebSocket on the 101 response');
    }
    ws.accept();

    try {
      const messagePromise = new Promise<MessageEvent>((resolve, reject) => {
        ws.addEventListener('message', (event) => resolve(event as MessageEvent), { once: true });
        ws.addEventListener('error', (event) => reject(event), { once: true });
      });

      const event = await messagePromise;
      const payload = JSON.parse(event.data as string) as { type: string; match: { players: { playerId: string }[] } };

      expect(payload.type).toBe('match');
      expect(payload.match.players).toHaveLength(1);
      expect(payload.match.players[0].playerId).toBe('p1');
    } finally {
      ws.close();
    }
  });

  it('broadcasts a match message to a connected socket when an RPC method runs', async () => {
    const stub = await createdBy('socket-broadcast');
    const token = await signToken({ sub: 'p1' });

    const { status, ws } = await openSocket(stub, `/ws?token=${token}`);
    try {
      expect(status).toBe(101);
      if (!ws) throw new Error('expected a client WebSocket on the 101 response');
      // TS's control-flow narrowing from the `if (!ws) throw` guard above doesn't persist into the
      // nested `nextMessage` closure below - rebind to a non-optional local so it type-checks.
      const socket: WebSocket = ws;

      function nextMessage(): Promise<MessageEvent> {
        return new Promise((resolve, reject) => {
          socket.addEventListener('message', (event) => resolve(event as MessageEvent), { once: true });
          socket.addEventListener('error', (event) => reject(event), { once: true });
        });
      }

      // The connection's own initial-state send arrives first - drain it before waiting for the
      // addPlayer-triggered broadcast below, or a `once` listener attached after it would consume
      // THIS message instead of the one this test actually cares about.
      await nextMessage();

      const messagePromise = nextMessage();

      const addPlayerResult = await stub.addPlayer('p2', Teams.TeamA);
      expect(addPlayerResult.ok).toBe(true);

      const event = await messagePromise;
      const payload = JSON.parse(event.data as string) as { type: string; match: { players: unknown[] } };

      expect(payload.type).toBe('match');
      expect(payload.match.players).toHaveLength(2);
    } finally {
      // Always close the client-side socket before the test ends - an unclosed WebSocket handle
      // dangles across the test boundary just like an unread Response body (see openSocket).
      ws?.close();
    }
  });

  describe('hidden hands', () => {
    type Payload = { match: { currentGame: { hands: { playerId: string; dominoes: unknown[]; hiddenCount?: number }[] } } };

    function deck() {
      const dominoes = [];
      for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dominoes.push(createDomino(i, j));
      return dominoes;
    }

    // p1 creates, p2-p4 take seats 1-3; the 4th seat deals.
    async function dealtMatch(name: string) {
      const stub = await createdBy(name);
      await stub.takeSeat('p2', 1);
      await stub.takeSeat('p3', 2);
      return stub;
    }

    async function connect(stub: ReturnType<typeof stubFor>, sub: string) {
      const { ws } = await openSocket(stub, `/ws?token=${await signToken({ sub })}`);
      if (!ws) throw new Error('expected a client WebSocket on the 101 response');
      const messages: Payload[] = [];
      const waiters: (() => void)[] = [];
      ws.addEventListener('message', (event) => {
        messages.push(JSON.parse((event as MessageEvent).data as string) as Payload);
        waiters.splice(0).forEach((wake) => wake());
      });
      const nth = async (n: number): Promise<Payload> => {
        while (messages.length < n) await new Promise<void>((resolve) => waiters.push(resolve));
        return messages[n - 1];
      };
      return { ws, nth };
    }

    const hand = (payload: Payload, playerId: string) =>
      payload.match.currentGame.hands.find((h) => h.playerId === playerId)!;

    it("broadcasts each player their own hand and only a count of everyone else's", async () => {
      const stub = await dealtMatch('socket-hidden-broadcast');
      const p1 = await connect(stub, 'p1');
      const p2 = await connect(stub, 'p2');
      try {
        await p1.nth(1);
        await p2.nth(1);

        await stub.takeSeat('p4', 3, deck());

        const forP1 = await p1.nth(2);
        const forP2 = await p2.nth(2);
        expect(hand(forP1, 'p1').dominoes).toHaveLength(7);
        expect(hand(forP1, 'p2')).toMatchObject({ dominoes: [], hiddenCount: 7 });
        expect(hand(forP2, 'p2').dominoes).toHaveLength(7);
        expect(hand(forP2, 'p1')).toMatchObject({ dominoes: [], hiddenCount: 7 });
      } finally {
        p1.ws.close();
        p2.ws.close();
      }
    });

    it('hides every hand from a connected socket whose user is not seated', async () => {
      const stub = await dealtMatch('socket-hidden-outsider');
      await stub.takeSeat('p4', 3, deck());
      const outsider = await connect(stub, 'p5');
      try {
        const first = await outsider.nth(1);

        expect(first.match.currentGame.hands.every((h) => h.dominoes.length === 0 && h.hiddenCount === 7)).toBe(true);
      } finally {
        outsider.ws.close();
      }
    });
  });

  // Regression test: a client that disconnects without sending a close frame (e.g. a tab
  // navigating away) reports close code 1005 ("No Status Received") to webSocketClose. 1005 is
  // reserved by the WebSocket protocol and throws `InvalidAccessError` if forwarded as-is to
  // `ws.close()` - this used to crash the DO's webSocketClose handler on every such disconnect.
  it('does not throw when webSocketClose receives the reserved 1005 close code', async () => {
    const stub = await createdBy('socket-reserved-close-code');

    await runInDurableObject(stub, async (instance, state) => {
      const matchDO = instance as unknown as MatchDO;
      const pair = new WebSocketPair();
      state.acceptWebSocket(pair[1]);
      await expect(matchDO.webSocketClose(pair[1], 1005, '', false)).resolves.toBeUndefined();
    });
  });
});

// MatchDO's push notifications: a change notifies the players it concerns (push/notices.ts), except
// anyone watching the match through an open socket, and the player who made it.
describe('MatchDO push notifications', () => {
  it('pushes to players without the match open, and not to one who has it open or made the change', async () => {
    const dealOrder: Domino[] = [];
    for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) dealOrder.push(createDomino(i, j));
    for (const id of ['p1', 'p2', 'p3', 'p4']) await saveToken(testEnv.DB, id, `ExponentPushToken[${id}]`, 'android');

    const stub = await createdBy('push-watching');
    await stub.takeSeat('p2', 1);
    await stub.takeSeat('p3', 2);
    const { ws } = await openSocket(stub, `/ws?token=${await signToken({ sub: 'p2' })}`);

    let sentTo: string[] | undefined;
    fetchMock
      .get('https://exp.host')
      .intercept({ path: '/--/api/v2/push/send', method: 'POST' })
      .reply((opts) => {
        const messages = JSON.parse(String(opts.body)) as { to: string }[];
        sentTo = messages.map((m) => m.to).sort();
        return { statusCode: 200, data: JSON.stringify({ data: messages.map(() => ({ status: 'ok', id: 't' })) }) };
      });

    // The last seat fills the table and deals: everyone hears the game is on, but p2 is watching,
    // and p4 just sat down - in the app that's the match screen, its socket maybe not open yet.
    await stub.takeSeat('p4', 3, dealOrder);
    // Polls rather than resolving a promise from the reply: that runs inside the Durable Object's
    // request, and a test resumed from there can't touch its socket or stub any more.
    await vi.waitFor(() => expect(sentTo).toBeDefined());
    expect(sentTo).toEqual(['ExponentPushToken[p1]', 'ExponentPushToken[p3]']);

    ws?.close();
  });

  // A rematch's first bidder (the seat after the last match's opener) is told to bid - unless
  // they have the finished match open, which takes them to the rematch. Their socket is on the
  // finished match, not the rematch, so the finished match names them on the way.
  it("doesn't push a rematch's first bidder who has the finished match open", async () => {
    const players = ['rm-p1', 'rm-p2', 'rm-p3', 'rm-p4'];
    for (const id of players) await saveToken(testEnv.DB, id, `ExponentPushToken[${id}]`, 'android');
    const sent: { to: string; data: { url: string } }[] = [];
    fetchMock
      .get('https://exp.host')
      .intercept({ path: '/--/api/v2/push/send', method: 'POST' })
      .reply((opts) => {
        const messages = JSON.parse(String(opts.body)) as typeof sent;
        sent.push(...messages);
        return { statusCode: 200, data: JSON.stringify({ data: messages.map(() => ({ status: 'ok', id: 't' })) }) };
      })
      .persist();
    // Every vote but rm-p4's, then rm-p4's, which creates the rematch.
    const rematchOf = async (name: string, beforeLastVote: (stub: ReturnType<typeof stubFor>) => Promise<void>) => {
      const stub = stubFor(name);
      await runInDurableObject(stub, (_instance, state) => state.storage.put('match', finishedMatch(name, players)));
      for (const id of players.slice(0, 3)) await stub.rematch(id);
      await beforeLastVote(stub);
      const result = await stub.rematch('rm-p4');
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.value.rematchId!;
    };

    let ws: WebSocket | undefined;
    await rematchOf('rematch-watched', async (stub) => {
      ({ ws } = await openSocket(stub, `/ws?token=${await signToken({ sub: 'rm-p2' })}`));
    });
    ws?.close();
    // The same with nobody watching pushes rm-p2. Were the first one pushed too, it would be sent
    // before this one, and show up below.
    const unwatched = await rematchOf('rematch-unwatched', async () => {});

    // Polls rather than resolving a promise from the reply, which runs inside the Durable Object.
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent).toEqual([
      expect.objectContaining({ to: 'ExponentPushToken[rm-p2]', data: { url: `/match/${unwatched}` } }),
    ]);
    // D1 isn't reset between tests.
    await testEnv.DB.prepare('DELETE FROM push_tokens').run();
  });
});
