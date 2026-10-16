// Who has played with whom (people/playedWith.ts): which changes count as a game starting, and
// the rows they write.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import { recordPlayedWith, startedPlayers } from '../src/people/playedWith';

const testEnv = env as unknown as Env;

// Just enough of a match for hasBeenDealt: a domino in each hand once dealt.
function table(ids: string[], dealt: boolean): MatchState {
  return {
    id: 'm1',
    players: ids.map((playerId, position) => ({ playerId, position, ready: true })),
    games: {},
    currentGame: { tricks: [], hands: ids.map((playerId) => ({ playerId, dominoes: dealt ? [{ top: 1, bottom: 2 }] : [] })) },
  } as unknown as MatchState;
}

describe('startedPlayers', () => {
  const four = ['ann', 'bo', 'cy', 'di'];

  it('counts the first deal, for every human', () => {
    expect(startedPlayers(table(four, false), table(four, true))).toEqual({ humans: four, newcomers: null });
  });

  it('counts a rematch, which arrives already dealt', () => {
    expect(startedPlayers(null, table(four, true))).toEqual({ humans: four, newcomers: null });
  });

  it('leaves bots out', () => {
    expect(startedPlayers(null, table(['ann', 'bot-1', 'bo', 'bot-3'], true))).toEqual({ humans: ['ann', 'bo'], newcomers: null });
  });

  it('counts only the newcomer when a seat is taken over in a game under way', () => {
    const before = table(['ann', 'bo', 'cy', 'bot-1'], true);
    const after = table(['ann', 'bo', 'cy', 'eve'], true);
    expect(startedPlayers(before, after)).toEqual({ humans: ['ann', 'bo', 'cy', 'eve'], newcomers: ['eve'] });
  });

  it('ignores every other change', () => {
    expect(startedPlayers(table(four, true), table(four, true))).toBeNull();
    expect(startedPlayers(table(['ann'], false), table(['ann', 'bo'], false))).toBeNull();
    expect(startedPlayers(null, table(['ann'], false))).toBeNull();
  });
});

describe('recordPlayedWith', () => {
  beforeEach(async () => {
    await testEnv.DB.prepare('DELETE FROM played_with').run();
  });

  async function rows() {
    const { results } = await testEnv.DB.prepare(
      'SELECT user_id, other_id, last_played_on, games FROM played_with ORDER BY user_id, other_id'
    ).all();
    return results;
  }

  it('writes each pair both ways and counts games', async () => {
    await recordPlayedWith(testEnv.DB, { humans: ['ann', 'bo'], newcomers: null }, '2026-10-01T00:00:00.000Z');
    await recordPlayedWith(testEnv.DB, { humans: ['ann', 'bo'], newcomers: null }, '2026-10-02T00:00:00.000Z');
    expect(await rows()).toEqual([
      { user_id: 'ann', other_id: 'bo', last_played_on: '2026-10-02T00:00:00.000Z', games: 2 },
      { user_id: 'bo', other_id: 'ann', last_played_on: '2026-10-02T00:00:00.000Z', games: 2 },
    ]);
  });

  it('writes only pairs with a newcomer', async () => {
    await recordPlayedWith(testEnv.DB, { humans: ['ann', 'bo', 'eve'], newcomers: ['eve'] }, '2026-10-03T00:00:00.000Z');
    expect((await rows()).map((r) => `${r.user_id}>${r.other_id}`)).toEqual(['ann>eve', 'bo>eve', 'eve>ann', 'eve>bo']);
  });

  it('writes nothing for a single human', async () => {
    await recordPlayedWith(testEnv.DB, { humans: ['ann'], newcomers: null }, '2026-10-03T00:00:00.000Z');
    expect(await rows()).toEqual([]);
  });
});
