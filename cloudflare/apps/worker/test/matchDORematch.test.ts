// The rematch flow at MatchDO's RPC boundary: votes collect on the finished match, and the vote
// that completes them creates the rematch's own DO before the old match records its id.
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { Positions, Teams, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import type { MatchDO } from '../src/matchDO';

const testEnv = env as unknown as Env;

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}

// Reads the whole body every time - see matchDO.test.ts's `rpc` for why.
async function rpc(stub: ReturnType<typeof stubFor>, method: string, body: Record<string, unknown>) {
  const res = await stub.fetch(`https://match-do/rpc/${method}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

// A match that just ended (TeamA reached 7), written straight into the DO's storage - playing a
// whole match through the RPCs would bury what these tests are about.
function finishedMatch(
  id: string,
  playerIds = ['p1', 'p2', 'p3', 'p4'],
  winningTeam: Teams | null = Teams.TeamA
): MatchState {
  return {
    id,
    createdOn: '2026-01-01T00:00:00.000Z',
    updatedOn: '2026-01-01T00:00:00.000Z',
    winningTeam,
    games: {},
    players: playerIds.map((playerId, position) => ({ playerId, position: position as Positions, ready: false })),
    currentGame: {
      id: 'g9',
      name: 'Game 9',
      firstActionBy: playerIds[0],
      bid: null,
      biddingPlayerId: null,
      trump: null,
      currentPlayerId: playerIds[0],
      hands: playerIds.map((playerId, position) => ({
        playerId,
        team: position % 2 === 0 ? Teams.TeamA : Teams.TeamB,
        dominoes: [],
        bid: null,
      })),
      currentTrick: { playerId: null, team: null, suit: null, dominoes: [null, null, null, null] },
      tricks: [],
    },
  };
}

async function seed(name: string, match: MatchState) {
  const stub = stubFor(name);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put('match', match);
  });
  return stub;
}

// A rematch seated with bots schedules their moves on its own DO. Runs them out (they stop at the
// human's turn) so no alarm is left pending when the test's isolated storage is torn down.
async function settleBots(matchId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (!(await runDurableObjectAlarm(stubFor(matchId)))) return;
  }
  throw new Error('too many bot alarm ticks');
}

describe('MatchDO rematch', () => {
  it('waits for every player, then creates the rematch before recording its id', async () => {
    const stub = await seed('rematch-four', finishedMatch('rematch-four'));

    for (const playerId of ['p1', 'p2', 'p3']) {
      const res = await rpc(stub, 'rematch', { playerId });
      expect(res.status).toBe(200);
      expect((res.body as MatchState).rematchId).toBeUndefined();
    }
    const last = await rpc(stub, 'rematch', { playerId: 'p4' });

    const rematchId = (last.body as MatchState).rematchId!;
    expect(rematchId).toBeTruthy();
    // The new match already exists by the time anyone could learn its id.
    const rematch = await rpc(stubFor(rematchId), 'getMatch', {});
    expect(rematch.status).toBe(200);
    const created = rematch.body as MatchState;
    expect(created.id).toBe(rematchId);
    expect(created.players.map((p) => [p.playerId, p.position])).toEqual([
      ['p1', 0],
      ['p2', 1],
      ['p3', 2],
      ['p4', 3],
    ]);
    expect(created.currentGame.hands.every((h) => h.dominoes.length === 7)).toBe(true);
  });

  it('counts bots as agreeing, so one human can start it alone', async () => {
    const stub = await seed('rematch-bots', finishedMatch('rematch-bots', ['p1', 'bot-1', 'bot-2', 'bot-3']));

    const res = await rpc(stub, 'rematch', { playerId: 'p1' });

    const { rematchId } = res.body as MatchState;
    expect(rematchId).toBeTruthy();
    await settleBots(rematchId!);
  });

  it('does not create a second rematch or redeal on a repeat vote', async () => {
    const stub = await seed('rematch-repeat', finishedMatch('rematch-repeat', ['p1', 'bot-1', 'bot-2', 'bot-3']));
    const first = (await rpc(stub, 'rematch', { playerId: 'p1' })).body as MatchState;
    await settleBots(first.rematchId!);
    const dealt = (await rpc(stubFor(first.rematchId!), 'getMatch', {})).body as MatchState;

    const again = (await rpc(stub, 'rematch', { playerId: 'p1' })).body as MatchState;

    expect(again.rematchId).toBe(first.rematchId);
    const after = (await rpc(stubFor(first.rematchId!), 'getMatch', {})).body as MatchState;
    expect(after.currentGame.id).toBe(dealt.currentGame.id);
    expect(after.currentGame.hands).toEqual(dealt.currentGame.hands);
  });

  it('rejects a vote on a match that is still being played', async () => {
    const stub = await seed('rematch-early', finishedMatch('rematch-early', undefined, null));

    const res = await rpc(stub, 'rematch', { playerId: 'p1' });

    expect(res.status).toBe(400);
  });

  it('rejects a vote from someone not seated', async () => {
    const stub = await seed('rematch-stranger', finishedMatch('rematch-stranger'));

    const res = await rpc(stub, 'rematch', { playerId: 'stranger' });

    expect(res.status).toBe(400);
  });

  it('lists the rematch in D1 as active for its players', async () => {
    const stub = await seed('rematch-lobby', finishedMatch('rematch-lobby', ['lobby-p1', 'bot-1', 'bot-2', 'bot-3']));

    const { rematchId } = (await rpc(stub, 'rematch', { playerId: 'lobby-p1' })).body as MatchState;
    await settleBots(rematchId!);

    const row = await testEnv.DB.prepare(
      `SELECT m.status FROM matches m JOIN match_players mp ON mp.match_id = m.id WHERE m.id = ? AND mp.player_id = ?`
    )
      .bind(rematchId, 'lobby-p1')
      .first<{ status: string }>();
    expect(row?.status).toBe('active');
  });
  it('keeps no rematch id when creating the rematch fails, so the last voter can retry', async () => {
    const stub = await seed('rematch-fails', finishedMatch('rematch-fails', ['p1', 'bot-1', 'bot-2', 'bot-3']));

    // The completing vote reaches a rematch DO that errors. `MatchDO.env` is private, so the
    // instance is viewed through a public `{ env }` just to swap MATCH_DO for this one call.
    await runInDurableObject(stub, async (instance) => {
      const withEnv = instance as unknown as { env: Env };
      const realEnv = withEnv.env;
      withEnv.env = {
        ...realEnv,
        MATCH_DO: {
          idFromName: (name: string) => realEnv.MATCH_DO.idFromName(name),
          get: () => ({ fetch: async () => Response.json({ title: 'boom' }, { status: 500 }) }),
        } as unknown as Env['MATCH_DO'],
      };
      try {
        await expect(
          (instance as MatchDO).fetch(
            new Request('https://do/rpc/rematch', { method: 'POST', body: JSON.stringify({ playerId: 'p1' }) })
          )
        ).rejects.toThrow();
      } finally {
        withEnv.env = realEnv;
      }
    });

    // Nobody who loads the match now is pointed at a match that doesn't exist, and p1's vote isn't
    // recorded, so their Rematch button stays live for another try.
    const stored = (await rpc(stub, 'getMatch', {})).body as MatchState;
    expect(stored.rematchId).toBeUndefined();
    expect(stored.rematchVotes ?? []).not.toContain('p1');

    const retried = (await rpc(stub, 'rematch', { playerId: 'p1' })).body as MatchState;
    expect(retried.rematchId).toBeTruthy();
    expect((await rpc(stubFor(retried.rematchId!), 'getMatch', {})).status).toBe(200);
    await settleBots(retried.rematchId!);
  });

  it('schedules bot moves again when creating a rematch is retried', async () => {
    const previous = finishedMatch('rematch-previous', ['p1', 'bot-1', 'bot-2', 'bot-3']);
    const stub = stubFor('rematch-retry-bots');
    const body = { matchId: 'rematch-retry-bots', previous, dealOrder: undefined };
    // p1 opened the last hand, so bot-1 bids first in the rematch and a bot move is due.
    const dealOrder = (await import('../src/bots')).shuffledDominoOrder();
    await rpc(stub, 'createRematch', { ...body, dealOrder });
    // As if the first attempt's alarm was lost (it failed before scheduling bots).
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });

    await rpc(stub, 'createRematch', { ...body, dealOrder });

    const alarm = await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    await settleBots('rematch-retry-bots');
  });
});
