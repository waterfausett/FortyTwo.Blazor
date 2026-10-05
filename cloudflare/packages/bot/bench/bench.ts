// Times the real bot in Node. Node runs the same V8 as workerd, so it's a proxy for the Worker's
// CPU time, not a measurement of it. The Workers Free plan allows 10 ms CPU per invocation, and
// each bot action is one Durable Object alarm, so two things matter:
//  - the cold path: in a fresh isolate, load + warmUp + the first decisions, in the order a real
//    hand makes them (4 bids, trump, then plays). Before warmUp existed the first play decision,
//    run in V8's interpreter, cost ~25 ms. Run this script several times: each run is one fresh
//    process. `--no-warmup` skips warmUp to show the cost it removes.
//  - warm decisions: p50/p95/max over 150 replayed hands after an untimed warm-up. The bar is a
//    p95 under 5 ms, leaving room for the rules engine, storage and broadcast in the same alarm.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createBot, loadWeights, warmUp } from '../src/index';
import { fixtureHands, type FixtureHand } from '../test/fixtures';
import { PLAYERS, applyStep, startHand } from '../test/replay';

const skipWarmUp = process.argv.includes('--no-warmup');
// Only the first fixture hand for now: parsing all of them makes ~30 MB of heap, and the old-space
// GCs that follow (10+ ms each) land on random decisions. A Worker isolate has no such heap.
const gz = gunzipSync(readFileSync(new URL('../test/fixtures/hands.jsonl.gz', import.meta.url)));
const firstHand = JSON.parse(gz.subarray(0, gz.indexOf(10)).toString('utf8')) as FixtureHand;
const models = new URL('../../../apps/web/public/models/', import.meta.url);

// Cold sequence, before anything else touches the bot's code.
let t = performance.now();
const manifest = JSON.parse(readFileSync(new URL('bot.json', models), 'utf8'));
const buf = readFileSync(new URL('bot.bin', models));
const bot = createBot(loadWeights(manifest, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
const load = performance.now() - t;
t = performance.now();
if (!skipWarmUp) warmUp();
const warm = performance.now() - t;
console.log(`cold: load (read + views + createBot) ${load.toFixed(1)} ms`);
console.log(`cold: warmUp ${skipWarmUp ? 'skipped' : `${warm.toFixed(1)} ms`}`);

function decide(match: ReturnType<typeof startHand>, s: FixtureHand['steps'][number]): number {
  const id = PLAYERS[s.seat];
  const start = performance.now();
  if (s.phase === 'bid') bot.decideBid(match, id);
  else if (s.phase === 'trump') bot.decideTrump(match, id);
  else bot.decideDomino(match, id);
  return performance.now() - start;
}

{
  const h = firstHand;
  let match = startHand(h);
  const seen: Record<string, number> = { bid: 0, trump: 0, play: 0 };
  let worstPlay = 0;
  for (const s of h.steps) {
    const dt = decide(match, s);
    const n = ++seen[s.phase];
    if (s.phase === 'play') worstPlay = Math.max(worstPlay, dt);
    if (s.phase !== 'play' || n <= 4) console.log(`cold: ${s.phase} #${n} ${dt.toFixed(1)} ms`);
    match = applyStep(match, s);
  }
  console.log(`cold: worst play in the first hand ${worstPlay.toFixed(1)} ms`);
}

// Warm decisions: untimed warm-up on hands outside the timed set, then 150 timed hands.
const all = fixtureHands();
function replay(h: FixtureHand, record?: Record<string, number[]>) {
  let match = startHand(h);
  for (const s of h.steps) {
    const dt = decide(match, s);
    record?.[s.phase].push(dt);
    match = applyStep(match, s);
  }
}
for (const h of all.slice(150, 170)) replay(h);
const times: Record<string, number[]> = { bid: [], trump: [], play: [] };
for (const h of all.slice(0, 150)) replay(h, times);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
for (const [phase, xs] of Object.entries(times)) {
  console.log(`${phase}: n=${xs.length} median ${pct(xs, 0.5).toFixed(2)} ms  p95 ${pct(xs, 0.95).toFixed(2)} ms  max ${pct(xs, 1).toFixed(2)} ms`);
}
