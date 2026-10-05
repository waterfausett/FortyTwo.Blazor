// Loads the shipped ML bot from the static assets (/models/bot.json + bot.bin, exported by
// `ml export`) and keeps it for the life of the isolate. Loading also JIT-warms the bot
// (@fortytwo/bot's warmUp), so no later decision runs the network in V8's interpreter, which
// would cost more CPU than the Workers Free plan's 10 ms per alarm.
//
// Only a loaded bot is kept. A failure - no binding, a fetch error, a missing file (the SPA
// fallback serves index.html), a Git LFS pointer, a layout mismatch - is logged and remembered
// for RETRY_MS, during which getMlBot resolves to null straight away (bots fall back to the simple
// rules in bots.ts); the first call after that tries again, so a transient ASSETS failure doesn't
// last the isolate's life. No promise is shared between calls: one started by a request and
// awaited by another breaks for the second if the first is cancelled (a CPU-limit kill, say), so
// calls that race a load each load, and the first bot to arrive is kept.
import { createBot, loadWeights, warmUp, type Bot } from '@fortytwo/bot';

export const RETRY_MS = 5 * 60 * 1000;

let bot: Bot | null = null;
let failedAt: number | null = null;
let clock: () => number = () => Date.now();

async function fetchAsset(assets: Fetcher, path: string): Promise<Response> {
  const res = await assets.fetch(new Request(`https://assets.local${path}`));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res;
}

async function load(env: { ASSETS?: Fetcher }): Promise<Bot> {
  if (!env.ASSETS) throw new Error('no ASSETS binding');
  const [manifestText, bin] = await Promise.all([
    fetchAsset(env.ASSETS, '/models/bot.json').then((r) => r.text()),
    fetchAsset(env.ASSETS, '/models/bot.bin').then((r) => r.arrayBuffer()),
  ]);
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error('/models/bot.json is not JSON (missing model?)');
  }
  const loaded = createBot(loadWeights(manifest, bin));
  warmUp();
  return loaded;
}

// Never rejects: null means "use the simple bots".
export async function getMlBot(env: { ASSETS?: Fetcher }): Promise<Bot | null> {
  if (bot !== null) return bot;
  if (failedAt !== null && clock() - failedAt < RETRY_MS) return null;
  try {
    const loaded = await load(env);
    bot ??= loaded;
    failedAt = null;
    return bot;
  } catch (e) {
    // Once per failed attempt, and attempts are RETRY_MS apart - not once per bot action. A
    // concurrent attempt that failed moments ago has already said it.
    if (failedAt === null || clock() - failedAt >= RETRY_MS) {
      console.error(`ML bot unavailable, using simple bots: ${e instanceof Error ? e.message : String(e)}`);
    }
    failedAt = clock();
    return null;
  }
}

// Forgets the loaded bot and any failure; `now` stands in for Date.now so tests can step past
// RETRY_MS.
export function resetMlBotForTest(now: () => number = () => Date.now()): void {
  bot = null;
  failedAt = null;
  clock = now;
}
