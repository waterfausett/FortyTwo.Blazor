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

const times: Record<string, number[]> = { bid: [], trump: [], play: [] };
for (const h of fixtureHands().slice(0, 150)) {
  let match = startHand(h);
  for (const s of h.steps) {
    const id = PLAYERS[s.seat];
    const start = performance.now();
    if (s.phase === 'bid') bot.decideBid(match, id);
    else if (s.phase === 'trump') bot.decideTrump(match, id);
    else bot.decideDomino(match, id);
    times[s.phase].push(performance.now() - start);
    match = applyStep(match, s);
  }
}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
console.log(`cold load (read + views + createBot): ${cold.toFixed(1)} ms`);
for (const [phase, xs] of Object.entries(times)) {
  console.log(`${phase}: n=${xs.length} median ${pct(xs, 0.5).toFixed(2)} ms  p95 ${pct(xs, 0.95).toFixed(2)} ms  max ${pct(xs, 1).toFixed(2)} ms`);
}
