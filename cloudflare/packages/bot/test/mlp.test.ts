import { describe, expect, it } from 'vitest';
import { dense, scoreCandidates, type Dense } from '../src/index';

const layer = (inDim: number, outDim: number, w: number[], b: number[]): Dense => ({
  inDim, outDim, w: Float32Array.from(w), b: Float32Array.from(b),
});

describe('mlp', () => {
  it('computes Wx + b with optional ReLU', () => {
    const l = layer(2, 2, [1, 2, -3, 1], [0.5, 0]);
    expect(Array.from(dense(l, [1, 1], false))).toEqual([3.5, -2]);
    expect(Array.from(dense(l, [1, 1], true))).toEqual([3.5, 0]);
  });

  it('scores candidates sharing an observation prefix like a plain forward pass', () => {
    const l1 = layer(3, 2, [1, -1, 2, 0.5, 1, -1], [0, 1]);
    const l2 = layer(2, 1, [1, 2], [-1]);
    const rows = [[1, 0, 1], [1, 0, 0], [1, 0, 3]];
    const plain = rows.map((r) => dense(l2, dense(l1, r, true), false)[0]);
    expect(scoreCandidates([l1, l2], 2, rows)).toEqual(plain);
  });
});
