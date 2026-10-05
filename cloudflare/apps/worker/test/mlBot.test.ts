// The ML bot's weights are read through the static-assets binding, from inside the Durable Object
// (matchDO.ts's alarm), so the DO's own env must expose ASSETS, not just the top-level Worker's.
import { describe, it, expect, beforeEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/index';
import { getMlBot, resetMlBotForTest } from '../src/mlBot';

const testEnv = env as unknown as Env;

beforeEach(() => resetMlBotForTest());

describe('ML bot loading', () => {
  it("MatchDO's env exposes the ASSETS binding", async () => {
    const stub = testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName('assets-binding'));
    const type = await runInDurableObject(stub, (instance) => typeof (instance as unknown as { env: Env }).env.ASSETS?.fetch);
    expect(type).toBe('function');
  });

  it('resolves to null (and caches it) when there is no ASSETS binding', async () => {
    expect(await getMlBot({})).toBeNull();
    // Cached: a later call with a working binding is not retried within the isolate.
    expect(await getMlBot(testEnv)).toBeNull();
  });

  it('resolves to null when the model files are absent or not a model', async () => {
    const assets = { fetch: async () => new Response('<html></html>') } as unknown as Fetcher;
    expect(await getMlBot({ ASSETS: assets })).toBeNull();
  });
});
