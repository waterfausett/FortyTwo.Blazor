// Loads the shipped ML bot from the static assets (/models/bot.json + bot.bin, exported by
// `ml export`) and keeps it for the life of the isolate.
//
// Getting a fresh isolate's bot ready costs more CPU than the Workers Free plan's 10 ms per
// invocation: the load itself, then a JIT warm-up (@fortytwo/bot's warmUpSteps) without which the
// first decisions would run the network in V8's interpreter. So it happens one piece per call:
// the call that loads returns WARMING, as does each call that runs one warm-up step, and only once
// every step has run does a call resolve to the bot. matchDO.ts's alarm spends an invocation on
// each piece and acts in the next one.
//
// Only a loaded bot is kept. A failure - no binding, a fetch error, a missing file (the SPA
// fallback serves index.html), a Git LFS pointer, a layout mismatch, a warm-up step throwing - is
// logged and remembered for RETRY_MS, during which getMlBot resolves to null straight away (bots
// fall back to the simple rules in bots.ts); the first call after that tries again, so a transient
// ASSETS failure doesn't last the isolate's life. No promise is shared between calls: one started
// by a request and awaited by another breaks for the second if the first is cancelled (a CPU-limit
// kill, say), so calls that race a load each load, and the first bot to arrive is kept.
import { createBot, loadWeights, warmUpSteps, type Bot } from '@fortytwo/bot';

export const RETRY_MS = 5 * 60 * 1000;
// What getMlBot resolves to while the bot is still being loaded or warmed up.
export const WARMING = 'warming';

let bot: Bot | null = null;
// A loaded bot and the warm-up steps it still needs before it is kept as `bot`.
let warming: { bot: Bot; steps: (() => void)[] } | null = null;
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
  return createBot(loadWeights(manifest, bin));
}

// Never rejects: null means "use the simple bots", WARMING means "this call spent its CPU getting
// the bot ready; ask again".
export async function getMlBot(env: { ASSETS?: Fetcher }): Promise<Bot | null | typeof WARMING> {
  if (bot !== null) return bot;
  if (failedAt !== null && clock() - failedAt < RETRY_MS) return null;
  try {
    if (warming === null) {
      const loaded = await load(env);
      failedAt = null;
      // A concurrent call may have loaded first; its bot is the one being warmed.
      if (bot === null && warming === null) {
        warming = { bot: loaded, steps: warmUpSteps().steps };
        console.log('ML bot loaded; warming up');
      }
      return WARMING;
    }
    const current = warming;
    current.steps.shift()!();
    if (current.steps.length === 0 && warming === current) {
      bot = current.bot;
      warming = null;
      console.log('ML bot ready');
    }
    return WARMING;
  } catch (e) {
    // Once per failed attempt, and attempts are RETRY_MS apart - not once per bot action. A
    // concurrent attempt that failed moments ago has already said it.
    if (failedAt === null || clock() - failedAt >= RETRY_MS) {
      console.error(`ML bot unavailable, using simple bots: ${e instanceof Error ? e.message : String(e)}`);
    }
    failedAt = clock();
    warming = null;
    return null;
  }
}

// Forgets the loaded bot and any failure; `now` stands in for Date.now so tests can step past
// RETRY_MS.
export function resetMlBotForTest(now: () => number = () => Date.now()): void {
  bot = null;
  warming = null;
  failedAt = null;
  clock = now;
}
