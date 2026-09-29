import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createDomino, Teams, type Domino } from '@fortytwo/rules';
import type { Env } from '../src/index';

const testEnv = env as unknown as Env;

// The full 28-domino set in a fixed order - enough to deterministically deal 4 hands of 7.
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
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}

// The value of a result that must have succeeded.
function valueOf<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error(`expected an ok result, got ${JSON.stringify(result)}`);
  return result.value;
}

describe('MatchDO RPC', () => {
  it('creates a match under the id it was addressed by, with one player', async () => {
    const stub = stubFor('create-match');

    const match = await stub.create('p1', 'create-match');

    expect(match.id).toBe('create-match');
    expect(match.players).toHaveLength(1);
    expect(match.players[0].playerId).toBe('p1');
  });

  it('supports addPlayer x3 and refuses an illegal bid with a 400 + title', async () => {
    const stub = stubFor('full-flow');

    await stub.create('p1', 'full-flow');
    await stub.addPlayer('p2', Teams.TeamA);
    await stub.addPlayer('p3', Teams.TeamB);
    const afterFourth = valueOf(await stub.addPlayer('p4', Teams.TeamB, fullDeck()));
    expect(afterFourth.players).toHaveLength(4);

    // p2 bidding out of turn (currentPlayerId is p1 after the deal resets to firstActionBy).
    const badBid = await stub.bid('p2', 30);
    expect(badBid).toMatchObject({ ok: false, status: 400, error: { title: expect.any(String) } });
  });

  it('persists state in storage across separate calls to the same stub', async () => {
    const stub = stubFor('persistence-check');

    await stub.create('p1', 'persistence-check');
    await stub.addPlayer('p2', Teams.TeamA);

    // A later, independent call must see state saved by an earlier one - proving the MatchState
    // round-trips through storage, not some in-memory field.
    const match = valueOf(await stub.getMatch());
    expect(match.players.map((p) => p.playerId)).toEqual(['p1', 'p2']);
  });

  describe('getMatch', () => {
    it('returns the full MatchState with no guards', async () => {
      const stub = stubFor('get-match');
      await stub.create('p1', 'get-match');

      const match = valueOf(await stub.getMatch());

      expect(match.currentGame).toBeDefined();
      expect(match.players).toHaveLength(1);
    });
  });

  describe('getPlayerView', () => {
    it('returns a narrow per-player DTO, not the full MatchState', async () => {
      const stub = stubFor('get-player-view');
      await stub.create('p1', 'get-player-view');

      const view = valueOf(await stub.getPlayerView('p1'));

      expect(view).toEqual({
        playerId: 'p1',
        team: Teams.TeamA,
        isActive: true,
        ready: true,
        dominoes: [],
        bid: null,
      });
      // Narrow DTO, not the full aggregate.
      expect(view).not.toHaveProperty('currentGame');
      expect(view).not.toHaveProperty('games');
    });

    it('refuses a caller who is not a player in this match with a 400', async () => {
      const stub = stubFor('get-player-view-non-member');
      await stub.create('p1', 'get-player-view-non-member');

      const result = await stub.getPlayerView('not-a-player');

      expect(result).toMatchObject({ ok: false, status: 400, error: { title: expect.any(String) } });
    });
  });

  describe('a match that was never created', () => {
    it('gets a clean 404 (not a crash) from every method except create', async () => {
      const stub = stubFor('never-created');

      const results = [
        await stub.addPlayer('p2', Teams.TeamA),
        await stub.takeSeat('p2', 1),
        await stub.addBots('p1'),
        await stub.readyUp('p1', true, fullDeck()),
        await stub.bid('p1', 30),
        await stub.setTrump('p1', 0),
        await stub.playDomino('p1', createDomino(0, 0)),
        await stub.rematch('p1'),
        await stub.getMatch(),
        await stub.getPlayerView('p1'),
      ];

      for (const result of results) {
        expect(result).toEqual({ ok: false, status: 404, error: { title: 'Match not found!' } });
      }
    });
  });

  describe('addPlayer dealOrder pass-through', () => {
    it('deals dominoes to all 4 hands when the 4th player join supplies a dealOrder', async () => {
      const stub = stubFor('deal-with-order');

      await stub.create('p1', 'deal-with-order');
      await stub.addPlayer('p2', Teams.TeamA);
      await stub.addPlayer('p3', Teams.TeamB);
      const match = valueOf(await stub.addPlayer('p4', Teams.TeamB, fullDeck()));

      expect(match.currentGame.hands).toHaveLength(4);
      for (const hand of match.currentGame.hands) {
        expect(hand.dominoes).toHaveLength(7);
      }
      expect(match.players.every((p) => p.ready === false)).toBe(true);
    });

    it('does not deal when the 4th player joins without a dealOrder', async () => {
      const stub = stubFor('deal-without-order');

      await stub.create('p1', 'deal-without-order');
      await stub.addPlayer('p2', Teams.TeamA);
      await stub.addPlayer('p3', Teams.TeamB);
      const match = valueOf(await stub.addPlayer('p4', Teams.TeamB));

      expect(match.currentGame.hands).toHaveLength(4);
      for (const hand of match.currentGame.hands) {
        expect(hand.dominoes).toHaveLength(0);
      }
      // No deal happened, so ready flags are untouched (still true from each join).
      expect(match.players.every((p) => p.ready === true)).toBe(true);
    });
  });
});
