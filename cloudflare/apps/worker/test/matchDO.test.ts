import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createDomino, Teams, type Domino, type MatchState, type LoggedInPlayer } from '@fortytwo/rules';
import type { Env } from '../src/index';

const testEnv = env as unknown as Env;

// A full, shuffled-in-name-only 28-domino deck - enough to deterministically deal 4 hands of 7.
// Mirrors the helper in matchEngine.test.ts; duplicated here rather than imported since this test
// exercises MatchDO's HTTP/RPC boundary, not matchEngine.ts directly.
function fullDeck(): Domino[] {
  const dominoes: Domino[] = [];
  for (let i = 0; i <= 6; i++) {
    for (let j = i; j <= 6; j++) {
      dominoes.push(createDomino(i, j));
    }
  }
  return dominoes;
}

function stubFor(name: string) {
  const id = testEnv.MATCH_DO.idFromName(name);
  return testEnv.MATCH_DO.get(id);
}

// Always fully consumes the response body (`.json()`) before returning, even when the caller
// doesn't need it - per Cloudflare's vitest-pool-workers isolated-storage guidance ("ensure
// entire response bodies are processed, even when not asserting content"), leaving a Response's
// body unread can leave a resource open across the test boundary and break storage teardown.
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

describe('MatchDO RPC', () => {
  it('creates a match and returns a MatchState with one player', async () => {
    const stub = stubFor('create-match');

    const res = await rpc(stub, 'create', { firstPlayerId: 'p1' });

    expect(res.status).toBe(200);
    const body = res.body as MatchState;
    expect(body.players).toHaveLength(1);
    expect(body.players[0].playerId).toBe('p1');
  });

  it('supports addPlayer x3 and rejects an illegal bid with a 400 + title', async () => {
    const stub = stubFor('full-flow');

    await rpc(stub, 'create', { firstPlayerId: 'p1' });
    await rpc(stub, 'addPlayer', { playerId: 'p2', team: Teams.TeamA });
    await rpc(stub, 'addPlayer', { playerId: 'p3', team: Teams.TeamB });
    const afterFourth = await rpc(stub, 'addPlayer', { playerId: 'p4', team: Teams.TeamB, dealOrder: fullDeck() });
    const fourthBody = afterFourth.body as MatchState;
    expect(fourthBody.players).toHaveLength(4);

    // p2 bidding out of turn (currentPlayerId is p1 after the deal resets to firstActionBy).
    const badBid = await rpc(stub, 'bid', { playerId: 'p2', bid: 30 });
    expect(badBid.status).toBe(400);
    const badBidBody = badBid.body as { title: string };
    expect(badBidBody.title).toBeTruthy();
  });

  it('persists state in storage across separate fetch calls to the same stub', async () => {
    const stub = stubFor('persistence-check');

    await rpc(stub, 'create', { firstPlayerId: 'p1' });
    await rpc(stub, 'addPlayer', { playerId: 'p2', team: Teams.TeamA });

    // A later, independent fetch call must see state saved by an earlier one - proving the
    // MatchState round-trips through `this.state.storage`, not some in-memory field.
    const res = await rpc(stub, 'getMatch', {});
    const body = res.body as MatchState;
    expect(body.players.map((p) => p.playerId)).toEqual(['p1', 'p2']);
  });

  describe('getMatch', () => {
    it('returns the full MatchState with no guards', async () => {
      const stub = stubFor('get-match');
      await rpc(stub, 'create', { firstPlayerId: 'p1' });

      const res = await rpc(stub, 'getMatch', {});

      expect(res.status).toBe(200);
      const body = res.body as MatchState;
      expect(body.currentGame).toBeDefined();
      expect(body.players).toHaveLength(1);
    });
  });

  describe('getPlayerView', () => {
    it('returns a narrow per-player DTO, not the full MatchState', async () => {
      const stub = stubFor('get-player-view');
      await rpc(stub, 'create', { firstPlayerId: 'p1' });

      const res = await rpc(stub, 'getPlayerView', { playerId: 'p1' });

      expect(res.status).toBe(200);
      const body = res.body as LoggedInPlayer;
      expect(body).toEqual({
        playerId: 'p1',
        team: Teams.TeamA,
        isActive: true,
        ready: true,
        dominoes: [],
        bid: null,
      });
      // Narrow DTO, not the full aggregate.
      expect(body).not.toHaveProperty('currentGame');
      expect(body).not.toHaveProperty('games');
    });

    it('returns 400 for a caller who is not a player in this match', async () => {
      const stub = stubFor('get-player-view-non-member');
      await rpc(stub, 'create', { firstPlayerId: 'p1' });

      const res = await rpc(stub, 'getPlayerView', { playerId: 'not-a-player' });

      expect(res.status).toBe(400);
      const body = res.body as { title: string };
      expect(body.title).toBeTruthy();
    });
  });

  describe('404 for a match that was never created', () => {
    it('returns a clean 404 (not a crash) for every RPC method except create', async () => {
      const stub = stubFor('never-created');

      const methods: [string, Record<string, unknown>][] = [
        ['addPlayer', { playerId: 'p2', team: Teams.TeamA }],
        ['readyUp', { playerId: 'p1', ready: true, dealOrder: fullDeck() }],
        ['bid', { playerId: 'p1', bid: 30 }],
        ['setTrump', { playerId: 'p1', suit: 0 }],
        ['playDomino', { playerId: 'p1', domino: createDomino(0, 0) }],
        ['getMatch', {}],
        ['getPlayerView', { playerId: 'p1' }],
      ];

      for (const [method, body] of methods) {
        const res = await rpc(stub, method, body);
        expect(res.status).toBe(404);
        const json = res.body as { title: string };
        expect(json.title).toBeTruthy();
      }
    });
  });

  describe('addPlayer dealOrder pass-through', () => {
    it('deals dominoes to all 4 hands when the 4th player join supplies a dealOrder', async () => {
      const stub = stubFor('deal-with-order');

      await rpc(stub, 'create', { firstPlayerId: 'p1' });
      await rpc(stub, 'addPlayer', { playerId: 'p2', team: Teams.TeamA });
      await rpc(stub, 'addPlayer', { playerId: 'p3', team: Teams.TeamB });
      const res = await rpc(stub, 'addPlayer', { playerId: 'p4', team: Teams.TeamB, dealOrder: fullDeck() });

      expect(res.status).toBe(200);
      const body = res.body as MatchState;
      expect(body.currentGame.hands).toHaveLength(4);
      for (const hand of body.currentGame.hands) {
        expect(hand.dominoes).toHaveLength(7);
      }
      expect(body.players.every((p) => p.ready === false)).toBe(true);
    });

    it('does not deal when the 4th player joins without a dealOrder', async () => {
      const stub = stubFor('deal-without-order');

      await rpc(stub, 'create', { firstPlayerId: 'p1' });
      await rpc(stub, 'addPlayer', { playerId: 'p2', team: Teams.TeamA });
      await rpc(stub, 'addPlayer', { playerId: 'p3', team: Teams.TeamB });
      const res = await rpc(stub, 'addPlayer', { playerId: 'p4', team: Teams.TeamB });

      expect(res.status).toBe(200);
      const body = res.body as MatchState;
      expect(body.currentGame.hands).toHaveLength(4);
      for (const hand of body.currentGame.hands) {
        expect(hand.dominoes).toHaveLength(0);
      }
      // No deal happened, so ready flags are untouched (still true from each join).
      expect(body.players.every((p) => p.ready === true)).toBe(true);
    });
  });
});
