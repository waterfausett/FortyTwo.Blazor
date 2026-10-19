// The rematch flow at MatchDO's RPC boundary: votes collect on the finished match, and the vote
// that completes them creates the rematch's own DO before the old match records its id.
import { describe, it, expect, vi } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { shuffledDominoOrder, type MatchState } from '@fortytwo/rules';
import type { Env } from '../src/index';
import type { MatchDO } from '../src/matchDO';
import { failingDb } from './failingDb';
import { finishedMatch } from './finishedMatch';
import { fetchMock } from './fetchMock';
import { saveToken } from '../src/push/tokens';

const testEnv = env as unknown as Env;

function stubFor(name: string) {
  return testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));
}

// The value of a result that must have succeeded.
function valueOf<T>(result: { ok: true; value: T } | { ok: false }): T {
  if (!result.ok) throw new Error(`expected an ok result, got ${JSON.stringify(result)}`);
  return result.value;
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
      expect(valueOf(await stub.rematch(playerId)).rematchId).toBeUndefined();
    }
    const last = valueOf(await stub.rematch('p4'));

    const rematchId = last.rematchId!;
    expect(rematchId).toBeTruthy();
    // The new match already exists by the time anyone could learn its id.
    const created = valueOf(await stubFor(rematchId).getMatch());
    expect(created.id).toBe(rematchId);
    expect(created.players.map((p) => [p.playerId, p.position])).toEqual([
      ['p1', 0],
      ['p2', 1],
      ['p3', 2],
      ['p4', 3],
    ]);
    expect(created.currentGame.hands.every((h) => h.dominoes.length === 7)).toBe(true);
  });

  // Nobody hears that a rematch is dealt: anyone on the finished match's screen - the one whose vote
  // completes the agreement, at least - is taken to it, and everyone else hears when it's their
  // turn. So only its first bidder (the seat after the last match's opener, p1) is pushed, and not
  // even them when it's their vote that starts it.
  it('pushes only the first bidder, unless their vote started it', async () => {
    const players = ['push-p1', 'push-p2', 'push-p3', 'push-p4'];
    for (const id of players) await saveToken(testEnv.DB, id, `ExponentPushToken[${id}]`, 'android');
    const sent: { to: string; body: string; data: { url: string } }[] = [];
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock
      .get('https://exp.host')
      .intercept({ path: '/--/api/v2/push/send', method: 'POST' })
      .reply((opts) => {
        const messages = JSON.parse(String(opts.body)) as typeof sent;
        sent.push(...messages);
        return { statusCode: 200, data: JSON.stringify({ data: messages.map(() => ({ status: 'ok', id: 't' })) }) };
      })
      .persist();
    const rematchOnLastVoteBy = async (name: string, lastVoter: string) => {
      const stub = await seed(name, finishedMatch(name, players));
      for (const id of players.filter((p) => p !== lastVoter)) await stub.rematch(id);
      return valueOf(await stub.rematch(lastVoter)).rematchId!;
    };

    // The first bidder starts this one, so it pushes nothing; had it, that push would be sent
    // before the next rematch's, and show up below.
    await rematchOnLastVoteBy('rematch-push-bidder', 'push-p2');
    const pushed = await rematchOnLastVoteBy('rematch-push-other', 'push-p4');

    // Polls rather than resolving a promise from the reply, which runs inside the Durable Object.
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent).toEqual([
      expect.objectContaining({ to: 'ExponentPushToken[push-p2]', body: expect.stringMatching(/^Your bid\nUs 0, Them 0$/), data: { url: `/match/${pushed}` } }),
    ]);
    // D1 isn't reset between tests.
    await testEnv.DB.prepare('DELETE FROM push_tokens').run();
  });

  it('counts bots as agreeing, so one human can start it alone', async () => {
    const stub = await seed('rematch-bots', finishedMatch('rematch-bots', ['p1', 'bot-1', 'bot-2', 'bot-3']));

    const { rematchId } = valueOf(await stub.rematch('p1'));

    expect(rematchId).toBeTruthy();
    await settleBots(rematchId!);
  });

  it('does not create a second rematch or redeal on a repeat vote', async () => {
    const stub = await seed('rematch-repeat', finishedMatch('rematch-repeat', ['p1', 'bot-1', 'bot-2', 'bot-3']));
    const first = valueOf(await stub.rematch('p1'));
    await settleBots(first.rematchId!);
    const dealt = valueOf(await stubFor(first.rematchId!).getMatch());

    const again = valueOf(await stub.rematch('p1'));

    expect(again.rematchId).toBe(first.rematchId);
    const after = valueOf(await stubFor(first.rematchId!).getMatch());
    expect(after.currentGame.id).toBe(dealt.currentGame.id);
    expect(after.currentGame.hands).toEqual(dealt.currentGame.hands);
  });

  it('rejects a vote on a match that is still being played', async () => {
    const stub = await seed('rematch-early', finishedMatch('rematch-early', undefined, null));

    expect(await stub.rematch('p1')).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects a vote from someone not seated', async () => {
    const stub = await seed('rematch-stranger', finishedMatch('rematch-stranger'));

    expect(await stub.rematch('stranger')).toMatchObject({ ok: false, status: 400 });
  });

  it('lists the rematch in D1 as active for its players', async () => {
    const stub = await seed('rematch-lobby', finishedMatch('rematch-lobby', ['lobby-p1', 'bot-1', 'bot-2', 'bot-3']));

    const { rematchId } = valueOf(await stub.rematch('lobby-p1'));
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

    // The completing vote reaches a rematch DO that errors. `MatchDO.env` is protected, so the
    // instance is viewed through a public `{ env }` just to swap MATCH_DO for this one call.
    await runInDurableObject(stub, async (instance: MatchDO) => {
      const withEnv = instance as unknown as { env: Env };
      const realEnv = withEnv.env;
      withEnv.env = {
        ...realEnv,
        MATCH_DO: {
          idFromName: (name: string) => realEnv.MATCH_DO.idFromName(name),
          get: () => ({
            createRematch: async () => {
              throw new Error('boom');
            },
          }),
        } as unknown as Env['MATCH_DO'],
      };
      try {
        await expect(instance.rematch('p1')).rejects.toThrow('boom');
      } finally {
        withEnv.env = realEnv;
      }
    });

    // Nobody who loads the match now is pointed at a match that doesn't exist, and p1's vote isn't
    // recorded, so their Rematch button stays live for another try.
    const stored = valueOf(await stub.getMatch());
    expect(stored.rematchId).toBeUndefined();
    expect(stored.rematchVotes ?? []).not.toContain('p1');

    const retried = valueOf(await stub.rematch('p1'));
    expect(retried.rematchId).toBeTruthy();
    expect((await stubFor(retried.rematchId!).getMatch()).ok).toBe(true);
    await settleBots(retried.rematchId!);
  });

  it('schedules bot moves again when creating a rematch is retried', async () => {
    const previous = finishedMatch('rematch-previous', ['p1', 'bot-1', 'bot-2', 'bot-3']);
    const stub = stubFor('rematch-retry-bots');
    // p1 opened the last hand, so bot-1 bids first in the rematch and a bot move is due.
    const dealOrder = shuffledDominoOrder();
    await stub.createRematch('rematch-retry-bots', previous, dealOrder);
    // As if the first attempt's alarm was lost (it failed before scheduling bots).
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });

    await stub.createRematch('rematch-retry-bots', previous, dealOrder);

    const alarm = await runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    await settleBots('rematch-retry-bots');
  });

  // Nobody may be in two Live games: the 'global' Matchmaker, shared by every test, is asked.
  it('makes no Live rematch while a player is at another Live table, and moves them on', async () => {
    const players = ['busy-p1', 'busy-p2', 'busy-p3', 'busy-p4'];
    const stub = await seed('rematch-live-busy', { ...finishedMatch('rematch-live-busy', players), mode: 'live' });
    const matchmaker = testEnv.MATCHMAKER.get(testEnv.MATCHMAKER.idFromName('global'));
    await matchmaker.play('busy-p4', 'live');

    for (const id of ['busy-p1', 'busy-p2', 'busy-p3']) await stub.rematch(id);
    const last = valueOf(await stub.rematch('busy-p4'));

    expect(last.rematchId).toBeUndefined();
    expect(last.movedOn).toEqual({ 'busy-p4': 'busy' });
    expect(valueOf(await stub.getMatch()).movedOn).toEqual({ 'busy-p4': 'busy' });
  });

  // The completing vote waits on the Matchmaker's check; someone moving on meanwhile is kept, and
  // there's no four left for a rematch.
  it('makes no Live rematch when someone moves on while the vote is being checked', async () => {
    const players = ['race-p1', 'race-p2', 'race-p3', 'race-p4'];
    const stub = await seed('rematch-live-race', { ...finishedMatch('rematch-live-race', players), mode: 'live' });
    for (const id of players.slice(0, 3)) await stub.rematch(id);

    await Promise.all([stub.rematch('race-p4'), stub.moveOn('race-p2')]);

    const stored = valueOf(await stub.getMatch());
    expect(stored.movedOn).toEqual({ 'race-p2': 'left' });
    expect(stored.rematchId).toBeUndefined();
  });

  // A retry after the first attempt made the rematch but didn't save its id: the four now sit at
  // that rematch, which mustn't count as another Live game.
  it('finishes a Live rematch on a retry, though its players already sit at it', async () => {
    const players = ['retry-p1', 'retry-p2', 'retry-p3', 'retry-p4'];
    const finished: MatchState = { ...finishedMatch('rematch-live-retry', players), mode: 'live' };
    const stub = await seed('rematch-live-retry', finished);
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('pendingRematchId', 'rematch-live-retry-next');
    });
    await stubFor('rematch-live-retry-next').createRematch('rematch-live-retry-next', finished, shuffledDominoOrder());
    const matchmaker = testEnv.MATCHMAKER.get(testEnv.MATCHMAKER.idFromName('global'));
    const { listing } = await stubFor('rematch-live-retry-next').getListing();
    await matchmaker.report('rematch-live-retry-next', 'live', listing);
    // Without the exception, every one of them is in a Live game.
    expect(await matchmaker.liveBusy(players)).toEqual(players);

    for (const id of players.slice(0, 3)) await stub.rematch(id);
    const last = valueOf(await stub.rematch('retry-p4'));

    expect(last.rematchId).toBe('rematch-live-retry-next');
    expect(last.movedOn).toBeUndefined();
  });

  // Two completing votes at once (a double tap, a second device, a retry) both wait on the
  // Matchmaker's check. The second must reuse the rematch the first made, and not count it as
  // another Live game.
  it('makes one Live rematch when the completing vote arrives twice at once', async () => {
    const players = ['double-p1', 'double-p2', 'double-p3', 'double-p4'];
    const stub = await seed('rematch-live-double', { ...finishedMatch('rematch-live-double', players), mode: 'live' });
    for (const id of players.slice(0, 3)) await stub.rematch(id);

    const results = (await Promise.all([stub.rematch('double-p4'), stub.rematch('double-p4')])).map(valueOf);

    const stored = valueOf(await stub.getMatch());
    expect(stored.rematchId).toBeTruthy();
    expect(results.map((r) => r.rematchId)).toEqual([stored.rematchId, stored.rematchId]);
    expect(stored.movedOn).toBeUndefined();
    const seatedAt = await testEnv.DB.prepare('SELECT DISTINCT match_id FROM match_players WHERE player_id = ? AND match_id != ?')
      .bind('double-p1', 'rematch-live-double')
      .all<{ match_id: string }>();
    expect(seatedAt.results.map((r) => r.match_id)).toEqual([stored.rematchId]);
  });

  // The other completing vote's rematch is made, and listed with all four, while this vote's check
  // is in flight: the check must be asked again without it, not move all four on.
  it('does not count a rematch made during the check as another Live game', async () => {
    const players = ['during-p1', 'during-p2', 'during-p3', 'during-p4'];
    const finished: MatchState = { ...finishedMatch('rematch-live-during', players), mode: 'live' };
    const stub = await seed('rematch-live-during', finished);
    for (const id of players.slice(0, 3)) await stub.rematch(id);
    const otherId = 'rematch-live-during-next';

    const last = await runInDurableObject(stub, async (instance: MatchDO, state) => {
      // Stubs made inside the DO, which can only do I/O through its own.
      const own = (instance as unknown as { env: Env }).env;
      const matchmaker = own.MATCHMAKER.get(own.MATCHMAKER.idFromName('global'));
      const other = own.MATCH_DO.get(own.MATCH_DO.idFromName(otherId));
      let first = true;
      (instance as unknown as { matchmaker: () => unknown }).matchmaker = () => ({
        liveBusy: async (ids: string[], except?: string) => {
          if (first) {
            first = false;
            // What the other vote does meanwhile: mint the id, make the rematch, list it.
            await state.storage.put('pendingRematchId', otherId);
            await other.createRematch(otherId, finished, shuffledDominoOrder());
            await matchmaker.report(otherId, 'live', (await other.getListing()).listing);
          }
          return matchmaker.liveBusy(ids, except);
        },
      });
      return valueOf(await instance.rematch('during-p4'));
    });

    expect(last.rematchId).toBe(otherId);
    expect(last.movedOn).toBeUndefined();
  });

  it('still creates the rematch when the lobby index is down, and lists it when retried', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previous = finishedMatch('rematch-no-db-previous', ['nodb-p1', 'nodb-p2', 'nodb-p3', 'nodb-p4']);
    const stub = stubFor('rematch-no-db');
    const dealOrder = shuffledDominoOrder();
    try {
      await runInDurableObject(stub, async (instance: MatchDO) => {
        const withEnv = instance as unknown as { env: Env };
        const realEnv = withEnv.env;
        withEnv.env = { ...realEnv, DB: failingDb() };
        try {
          expect((await instance.createRematch('rematch-no-db', previous, dealOrder)).id).toBe('rematch-no-db');
        } finally {
          withEnv.env = realEnv;
        }
      });
      expect(logged).toHaveBeenCalledWith('Failed to sync the lobby index for match rematch-no-db', expect.any(Error));
    } finally {
      logged.mockRestore();
    }
    const lobbyRow = () =>
      testEnv.DB.prepare('SELECT player_count FROM matches WHERE id = ?').bind('rematch-no-db').first<{ player_count: number }>();
    expect(await lobbyRow()).toBeNull();

    // The voter's retry finds the match already made, and this time its lobby rows are written.
    await stub.createRematch('rematch-no-db', previous, dealOrder);

    expect((await lobbyRow())?.player_count).toBe(4);
  });
});
