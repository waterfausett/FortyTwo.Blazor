// The ML bot's weights are read through the static-assets binding, from inside the Durable Object
// (matchDO.ts's alarm), so the DO's own env must expose ASSETS, not just the top-level Worker's.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Bid, createMatch, shuffledDominoOrder, takeSeat } from '@fortytwo/rules';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/index';
import { RETRY_MS, getMlBot, resetMlBotForTest } from '../src/mlBot';

const testEnv = env as unknown as Env;

beforeEach(() => resetMlBotForTest());

describe('ML bot loading', () => {
  it("MatchDO's env exposes the ASSETS binding", async () => {
    const stub = testEnv.MATCH_DO.get(testEnv.MATCH_DO.idFromName('assets-binding'));
    const type = await runInDurableObject(stub, (instance) => typeof (instance as unknown as { env: Env }).env.ASSETS?.fetch);
    expect(type).toBe('function');
  });

  it('resolves to null when there is no ASSETS binding', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getMlBot({})).toBeNull();
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('resolves to null when the model files are absent or not a model', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const assets = { fetch: async () => new Response('<html></html>') } as unknown as Fetcher;
    expect(await getMlBot({ ASSETS: assets })).toBeNull();
    logged.mockRestore();
  });

  it('resolves to null, never rejecting, when the ASSETS fetch itself fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const assets = { fetch: async () => { throw new Error('network down'); } } as unknown as Fetcher;
    expect(await getMlBot({ ASSETS: assets })).toBeNull();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('network down'));
    logged.mockRestore();
  });

  // A stub ASSETS serving the tiny fixture model: the Worker's whole load path with real bytes.
  function stubAssets(bin: BodyInit): Fetcher {
    const files: Record<string, BodyInit> = { '/models/bot.json': env.TINY_BOT_JSON, '/models/bot.bin': bin };
    return {
      fetch: async (req: Request) => {
        const body = files[new URL(req.url).pathname];
        return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
      },
    } as unknown as Fetcher;
  }
  const tinyBin = () => Uint8Array.from(atob(env.TINY_BOT_BIN_B64), (c) => c.charCodeAt(0));

  // Counts the fetches, so a test can tell a cached answer from a reload.
  function counted(assets: Fetcher): { assets: Fetcher; fetches: () => number } {
    let n = 0;
    const wrapped = { fetch: (req: Request) => { n++; return assets.fetch(req); } } as unknown as Fetcher;
    return { assets: wrapped, fetches: () => n };
  }
  const pointer = ['version https://git-lfs.github.com/spec/v1', 'oid sha256:abc', 'size 33212', ''].join(String.fromCharCode(10));

  it('loads a real (tiny) model through the ASSETS load path, keeps it, and decides a bid', async () => {
    const { assets, fetches } = counted(stubAssets(tinyBin()));
    const bot = await getMlBot({ ASSETS: assets });
    expect(bot).not.toBeNull();
    expect(await getMlBot({ ASSETS: assets })).toBe(bot);
    expect(fetches()).toBe(2); // bot.json and bot.bin, once
    let m = createMatch('human');
    m = takeSeat(m, 'bot-1', 1);
    m = takeSeat(m, 'bot-2', 2);
    m = takeSeat(m, 'bot-3', 3, shuffledDominoOrder(() => 0.5));
    const bid = bot!.decideBid({ ...m, currentGame: { ...m.currentGame, firstActionBy: 'bot-1', currentPlayerId: 'bot-1' } }, 'bot-1');
    expect(Object.values(Bid)).toContain(bid);
  });

  it('loads concurrently without sharing a promise, keeping one bot', async () => {
    const { assets } = counted(stubAssets(tinyBin()));
    const [a, b] = await Promise.all([getMlBot({ ASSETS: assets }), getMlBot({ ASSETS: assets })]);
    expect(a).not.toBeNull();
    expect(b).toBe(a); // the second to finish gets the first one's bot
    expect(await getMlBot({ ASSETS: assets })).toBe(a);
  });

  it('backs off after a failure (one log line, no refetch), then retries once RETRY_MS has passed', async () => {
    let now = 1_000_000;
    resetMlBotForTest(() => now);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lfs = counted(stubAssets(pointer));

    expect(await getMlBot({ ASSETS: lfs.assets })).toBeNull();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('LFS pointer'));
    const fetched = lfs.fetches();

    // Within the back-off: null straight away, no fetch, no new log line.
    now += RETRY_MS - 1;
    expect(await getMlBot({ ASSETS: lfs.assets })).toBeNull();
    expect(await getMlBot({ ASSETS: lfs.assets })).toBeNull();
    expect(lfs.fetches()).toBe(fetched);
    expect(logged).toHaveBeenCalledTimes(1);

    // After it: tried again, and a fixed model is picked up.
    now += 1;
    const fixed = counted(stubAssets(tinyBin()));
    expect(await getMlBot({ ASSETS: fixed.assets })).not.toBeNull();
    expect(fixed.fetches()).toBe(2);
    logged.mockRestore();
  });

  it('logs again for a retry that fails too, but not in between', async () => {
    let now = 0;
    resetMlBotForTest(() => now);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lfs = { ASSETS: stubAssets(pointer) };
    expect(await getMlBot(lfs)).toBeNull();
    now += RETRY_MS;
    expect(await getMlBot(lfs)).toBeNull();
    now += 1;
    expect(await getMlBot(lfs)).toBeNull();
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });
});
