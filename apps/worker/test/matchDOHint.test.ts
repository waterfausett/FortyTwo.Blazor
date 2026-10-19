// Hints (#76) against the real MatchDO: practice matches only, the asker's own turn, the model
// warming up one piece per call in a fresh isolate, and nothing about the match changing.
import { describe, it, expect, vi } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import type { MatchState } from '@fortytwo/rules';
import { warmUpSteps } from '@fortytwo/bot';
import type { HintResponse } from '@fortytwo/api-types';
import type { Env } from '../src/index';
import type { MatchDO, MatchResult } from '../src/matchDO';
import { resetMlBotForTest } from '../src/mlBot';

const testEnv = env as unknown as Env;
const stubFor = (name: string) => testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName(name));

function valueOf<T>(result: MatchResult<T>): T {
  if (!result.ok) throw new Error(`expected an ok result, got ${JSON.stringify(result)}`);
  return result.value;
}

// ASSETS serving the tiny fixture model, or nothing at all.
function modelAssets(): Fetcher {
  const bin = Uint8Array.from(atob(env.TINY_BOT_BIN_B64), (c) => c.charCodeAt(0));
  const files: Record<string, BodyInit> = { '/models/bot.json': env.TINY_BOT_JSON, '/models/bot.bin': bin };
  return {
    fetch: async (req: Request) => {
      const body = files[new URL(req.url).pathname];
      return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
    },
  } as unknown as Fetcher;
}
const noAssets = { fetch: async () => new Response('not found', { status: 404 }) } as unknown as Fetcher;

async function runAllPendingAlarms(stub: ReturnType<typeof stubFor>): Promise<void> {
  for (let i = 0; i < 30; i++) if (!(await runDurableObjectAlarm(stub))) return;
  throw new Error('too many alarm ticks');
}

// A practice match with the bots played up to human-1's first turn. The DO's env is set before the
// match exists, and its alarms an hour later than asked, so only the test runs them.
async function practiceOnMyTurn(
  name: string,
  { botsEnabled = 'true', hintsEnabled = undefined as string | undefined, assets = modelAssets() } = {}
) {
  resetMlBotForTest();
  const stub = stubFor(name);
  await runInDurableObject(stub, async (instance: MatchDO) => {
    const withEnv = instance as unknown as { env: Env; ctx: DurableObjectState };
    withEnv.env = { ...withEnv.env, BOTS_ENABLED: botsEnabled, HINTS_ENABLED: hintsEnabled, ASSETS: assets };
    const storage = withEnv.ctx.storage;
    const setAlarm = storage.setAlarm.bind(storage);
    storage.setAlarm = (time, options) => setAlarm(new Date(time).getTime() + 60 * 60 * 1000, options);
  });
  await stub.createVsBots('human-1', name);
  await runAllPendingAlarms(stub);
  const match = valueOf(await stub.getMatch());
  expect(match.currentGame.currentPlayerId).toBe('human-1');
  return stub;
}

// Asks until the reply isn't 'warming', the way the client's retries would.
async function hintUntilReady(stub: ReturnType<typeof stubFor>, playerId = 'human-1') {
  for (let calls = 1; calls <= 20; calls++) {
    const result = await stub.hint(playerId);
    if (!result.ok || result.value.status !== 'warming') return { result, calls };
  }
  throw new Error('still warming after 20 calls');
}

describe('MatchDO hint', () => {
  it("warms the model up one piece per call in a fresh isolate, then answers with the bot's bid", async () => {
    const stub = await practiceOnMyTurn('hint-warming');
    resetMlBotForTest();

    const { result, calls } = await hintUntilReady(stub);

    expect(calls).toBe(1 + warmUpSteps().steps.length + 1);
    const value = valueOf(result) as Extract<HintResponse, { status: 'ready' }>;
    expect(value.status).toBe('ready');
    expect(value.hint.kind).toBe('bid');
  });

  it('answers in one call once the model is warm', async () => {
    const stub = await practiceOnMyTurn('hint-warm');
    await hintUntilReady(stub);
    expect(valueOf(await stub.hint('human-1')).status).toBe('ready');
  });

  it("says 'unavailable' when the model can't be loaded", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stub = await practiceOnMyTurn('hint-no-model', { assets: noAssets });
    expect(valueOf(await stub.hint('human-1'))).toEqual({ status: 'unavailable' });
    logged.mockRestore();
  });

  it('changes nothing about the match', async () => {
    const stub = await practiceOnMyTurn('hint-read-only');
    const before = valueOf(await stub.getMatch());
    await hintUntilReady(stub);
    expect(valueOf(await stub.getMatch())).toEqual(before);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("refuses a hint when it isn't the asker's turn", async () => {
    const stub = await practiceOnMyTurn('hint-not-turn');
    const result = await stub.hint('hint-not-turn_bot-1');
    expect(result).toMatchObject({ ok: false, status: 400, error: { title: 'Not your turn' } });
  });

  it('refuses anyone not seated', async () => {
    const stub = await practiceOnMyTurn('hint-stranger');
    expect(await stub.hint('stranger')).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses when bots are switched off', async () => {
    const stub = await practiceOnMyTurn('hint-off', { botsEnabled: 'false' });
    expect(await stub.hint('human-1')).toMatchObject({ ok: false, status: 400, error: { title: 'Hints are off' } });
  });

  it('refuses when hints are switched off', async () => {
    const stub = await practiceOnMyTurn('hint-switched-off', { hintsEnabled: 'false' });
    expect(await stub.hint('human-1')).toMatchObject({ ok: false, status: 400, error: { title: 'Hints are off' } });
  });

  it('refuses a custom match, even one with bots seated', async () => {
    const stub = stubFor('hint-custom');
    await stub.create('human-1', 'hint-custom');
    await stub.addBots('human-1');
    expect(await stub.hint('human-1')).toMatchObject({ ok: false, status: 400, error: { title: 'Practice matches only' } });
  });

  it('refuses a practice match not on the standard rules', async () => {
    const stub = await practiceOnMyTurn('hint-house-rules');
    await runInDurableObject(stub, async (_i, state) => {
      const m = (await state.storage.get<MatchState>('match'))!;
      await state.storage.put('match', { ...m, rules: { low: 'off', plunge: true, allPass: 'forceLast', marksToWin: 7 } });
    });
    expect(await stub.hint('human-1')).toMatchObject({ ok: false, status: 400, error: { title: 'Practice matches only' } });
  });
});
