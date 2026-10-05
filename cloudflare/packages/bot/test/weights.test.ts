import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadWeights, WeightsError } from '../src/index';
import { fixtureWeights } from './fixtures';

const dir = new URL('./fixtures/', import.meta.url);
const manifest = () => JSON.parse(readFileSync(new URL('tiny-bot.json', dir), 'utf8'));
const bin = () => {
  const b = readFileSync(new URL('tiny-bot.bin', dir));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

describe('loadWeights', () => {
  it('reads the fixture bot with consistent layer sizes', () => {
    const w = fixtureWeights();
    expect(w.play[0].inDim).toBe(363);
    expect(w.play.at(-1)!.outDim).toBe(1);
    expect(w.bidBody[0].inDim).toBe(36);
    expect(w.pointsHead.outDim).toBe(98);
    expect(w.binaryHead.outDim).toBe(12);
  });

  it('rejects a Git LFS pointer instead of the weights', () => {
    const pointer = new TextEncoder().encode('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 6\n');
    expect(() => loadWeights(manifest(), pointer.buffer)).toThrow(/LFS pointer/);
  });

  it('rejects a bin of the wrong size', () => {
    expect(() => loadWeights(manifest(), bin().slice(4))).toThrow(WeightsError);
  });

  it('rejects an encoder layout this bot does not implement', () => {
    expect(() => loadWeights({ ...manifest(), playInputDim: 999 }, bin())).toThrow(/playInputDim/);
    expect(() => loadWeights({ ...manifest(), bidInputLayout: 2 }, bin())).toThrow(/bidInputLayout/);
    expect(() => loadWeights({ ...manifest(), format: 2 }, bin())).toThrow(/format/);
  });

  it('rejects something that is not a manifest', () => {
    expect(() => loadWeights('<!doctype html>', bin())).toThrow(WeightsError);
  });
});
