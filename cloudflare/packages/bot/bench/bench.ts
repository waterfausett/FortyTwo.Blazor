// Times the real bot in Node: decisions replayed from the fixture hands' positions, plus the cold
// load. The Workers Free plan allows 10 ms CPU per invocation; the bar here is a decision p95
// under 5 ms, leaving room for the rules engine, storage and broadcast in the same alarm.
import { readFileSync } from 'node:fs';
import { createBot, loadWeights } from '../src/index';
import { fixtureHands } from '../test/fixtures';
import { PLAYERS, applyStep, startHand } from '../test/replay';

const models = new URL('../../../apps/web/public/models/', import.meta.url);
const t0 = performance.now();
const manifest = JSON.parse(readFileSync(new URL('bot.json', models), 'utf8'));
const buf = readFileSync(new URL('bot.bin', models));
const bot = createBot(loadWeights(manifest, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
const cold = performance.now() - t0;

// Untimed warm-up on hands outside the timed set, after timing the very first decision (cold JIT).
function replay(h: ReturnType<typeof fixtureHands>[number], record?: Record<string, number[]>) {
  let match = startHand(h);
  for (const s of h.steps) {
    const id = PLAYERS[s.seat];
    const start = performance.now();
    if (s.phase === 'bid') bot.decideBid(match, id);
    else if (s.phase === 'trump') bot.decideTrump(match, id);
    else bot.decideDomino(match, id);
    const dt = performance.now() - start;
    if (first === undefined) first = dt;
    record?.[s.phase].push(dt);
    match = applyStep(match, s);
  }
}
let first: number | undefined;
const all = fixtureHands();
for (const h of all.slice(150, 170)) replay(h);
const times: Record<string, number[]> = { bid: [], trump: [], play: [] };
for (const h of all.slice(0, 150)) replay(h, times);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
console.log(`first decision (cold JIT): ${first!.toFixed(1)} ms`);
console.log(`cold load (read + views + createBot): ${cold.toFixed(1)} ms`);
for (const [phase, xs] of Object.entries(times)) {
  console.log(`${phase}: n=${xs.length} median ${pct(xs, 0.5).toFixed(2)} ms  p95 ${pct(xs, 0.95).toFixed(2)} ms  max ${pct(xs, 1).toFixed(2)} ms`);
}
