// Loads the shipped ML bot once per isolate from the static assets (/models/bot.json + bot.bin,
// exported by `ml export`). Any failure - no binding, a missing file (the SPA fallback serves
// index.html), a Git LFS pointer, a layout mismatch - is logged once and cached as null, so bots
// fall back to the simple rules in bots.ts instead of stalling a match.
import { createBot, loadWeights, type Bot } from '@fortytwo/bot';

let cached: Promise<Bot | null> | null = null;

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

export function getMlBot(env: { ASSETS?: Fetcher }): Promise<Bot | null> {
  cached ??= load(env).catch((e: unknown) => {
    console.error(`ML bot unavailable, using simple bots: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  return cached;
}

export function resetMlBotForTest(): void {
  cached = null;
}
