// The ML bot's weights are read through the static-assets binding, from inside the Durable Object
// (matchDO.ts's alarm), so the DO's own env must expose ASSETS, not just the top-level Worker's.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Bid, createMatch, shuffledDominoOrder, takeSeat } from '@fortytwo/rules';
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

  // A stub ASSETS serving the tiny fixture model: the Worker's whole load path with real bytes.
  function stubAssets(bin: BodyInit): Fetcher {
    const files: Record<string, BodyInit> = { '/models/bot.json': testEnv.TINY_BOT_JSON, '/models/bot.bin': bin };
    return {
      fetch: async (req: Request) => {
        const body = files[new URL(req.url).pathname];
        return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
      },
    } as unknown as Fetcher;
  }
  const tinyBin = () => Uint8Array.from(atob(testEnv.TINY_BOT_BIN_B64), (c) => c.charCodeAt(0));

  it('loads a real (tiny) model through the ASSETS load path and decides a bid', async () => {
    const bot = await getMlBot({ ASSETS: stubAssets(tinyBin()) });
    expect(bot).not.toBeNull();
    let m = createMatch('human');
    m = takeSeat(m, 'bot-1', 1);
    m = takeSeat(m, 'bot-2', 2);
    m = takeSeat(m, 'bot-3', 3, shuffledDominoOrder(() => 0.5));
    const bid = bot!.decideBid({ ...m, currentGame: { ...m.currentGame, firstActionBy: 'bot-1', currentPlayerId: 'bot-1' } }, 'bot-1');
    expect(Object.values(Bid)).toContain(bid);
  });

  it('resolves to null, logging once, when the .bin is a Git LFS pointer', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pointer = ['version https://git-lfs.github.com/spec/v1', 'oid sha256:abc', 'size 33212', ''].join(String.fromCharCode(10));
    expect(await getMlBot({ ASSETS: stubAssets(pointer) })).toBeNull();
    expect(await getMlBot({ ASSETS: stubAssets(pointer) })).toBeNull(); // cached, not retried
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});
