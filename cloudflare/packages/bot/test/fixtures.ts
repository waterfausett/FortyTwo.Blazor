import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { loadWeights, type BotWeights } from '../src/index';

const dir = new URL('./fixtures/', import.meta.url);

export type FixtureStep = {
  seat: number;
  phase: 'bid' | 'trump' | 'play';
  action: number | string;
  scripted: boolean;
  bidInput?: number[];
  table?: { points: number[][]; high: number[]; low: number[]; plunge: number | null };
  legal?: string[];
  features?: [number, number][][];
  q?: number[];
};
export type FixtureHand = { deal: string[]; opener: number; steps: FixtureStep[] };

export function fixtureWeights(): BotWeights {
  const manifest = JSON.parse(readFileSync(new URL('tiny-bot.json', dir), 'utf8'));
  const buf = readFileSync(new URL('tiny-bot.bin', dir));
  return loadWeights(manifest, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export function fixtureHands(): FixtureHand[] {
  return gunzipSync(readFileSync(new URL('hands.jsonl.gz', dir)))
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as FixtureHand);
}

export function tolerantEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-5 * Math.max(1, Math.abs(b));
}
