// Stats are recorded by the play that wins a match - from a route (update) or a bot (alarm) - and
// by nothing else; a D1 failure is logged loudly and the play still goes through.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { createDomino, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import type { MatchDO } from '../src/matchDO';
import { almostWonMatch } from './almostWonMatch';
import { failingDb } from './failingDb';

const testEnv = env as unknown as Env;

async function seed(name: string, match: MatchState) {
  const stub = testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('match', match);
  });
  return stub;
}

async function statsRows(matchId: string) {
  const { results } = await testEnv.DB.prepare(
    'SELECT player_id AS playerId, won, marks_won AS marksWon, bids_won AS bidsWon, with_bots AS withBots FROM player_match_stats WHERE match_id = ? ORDER BY player_id'
  )
    .bind(matchId)
    .all();
  return results;
}

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM player_match_stats').run();
});

describe('MatchDO player stats', () => {
  it('records every human once when a play wins the match', async () => {
    const stub = await seed('stats-win', almostWonMatch('stats-win'));

    const result = await stub.playDomino('p4', createDomino(1, 3));
    expect(result.ok && result.value.winningTeam).toBeTruthy();

    expect(await statsRows('stats-win')).toEqual([
      { playerId: 'p1', won: 1, marksWon: 7, bidsWon: 7, withBots: 0 },
      { playerId: 'p2', won: 0, marksWon: 0, bidsWon: 0, withBots: 0 },
      { playerId: 'p3', won: 1, marksWon: 7, bidsWon: 0, withBots: 0 },
      { playerId: 'p4', won: 0, marksWon: 0, bidsWon: 0, withBots: 0 },
    ]);
  });

  it('records nothing for a play that does not win the match', async () => {
    const match = almostWonMatch('stats-none');
    // One mark short: the same play makes the hand but leaves TeamA on 6.
    const stub = await seed('stats-none', { ...match, games: { 1: match.games[1]!.slice(1) } });
    await stub.playDomino('p4', createDomino(1, 3));
    expect(await statsRows('stats-none')).toEqual([]);
  });

  it('records nothing for plays after the match is already won', async () => {
    const stub = await seed('stats-after', almostWonMatch('stats-after', undefined, createDomino(0, 2)));
    await stub.playDomino('p4', createDomino(1, 3));
    await testEnv.DB.prepare('DELETE FROM player_match_stats').run();

    // p1 took the last trick, so leads next - a play on a match that's already won.
    const after = await stub.playDomino('p1', createDomino(0, 2));
    expect(after.ok).toBe(true);
    expect(await statsRows('stats-after')).toEqual([]);
  });

  it('records the match when a bot makes the winning play', async () => {
    const stub = await seed('stats-bot', almostWonMatch('stats-bot', ['p1', 'bot-1', 'p3', 'bot-2']));
    // The seeded state is bot-2's turn. Armed an hour out, so only the test runs it.
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await statsRows('stats-bot')).toEqual([
      { playerId: 'p1', won: 1, marksWon: 7, bidsWon: 7, withBots: 1 },
      { playerId: 'p3', won: 1, marksWon: 7, bidsWon: 0, withBots: 1 },
    ]);
  });

  it('logs loudly and still wins the match when D1 is down', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = await seed('stats-no-db', almostWonMatch('stats-no-db'));
    let realEnv: Env | undefined;
    await runInDurableObject(stub, async (instance: MatchDO) => {
      const withEnv = instance as unknown as { env: Env };
      realEnv = withEnv.env;
      withEnv.env = { ...realEnv, DB: failingDb() };
    });
    try {
      const result = await stub.playDomino('p4', createDomino(1, 3));
      expect(result.ok && result.value.winningTeam).toBeTruthy();
      expect(logged).toHaveBeenCalledWith('PLAYER STATS WRITE FAILED for match stats-no-db', expect.any(Error));
    } finally {
      await runInDurableObject(stub, async (instance: MatchDO) => {
        (instance as unknown as { env: Env }).env = realEnv!;
      });
      logged.mockRestore();
    }
  });
});
