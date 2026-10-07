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

  it('matches a plain forward pass bit for bit across candidate blocks, sparse inputs and zero sums', () => {
    // Five candidates: one block of four plus a remainder of one. The last candidate's second hidden
    // layer is all zeros and l3's bias is -0, so it must still come out +0, as the full sum gives.
    const l1 = layer(3, 3, [1, -1, 2, -1, 1, -1, 0.5, 0.25, -3], [0, 0.1, -0.2]);
    const l2 = layer(3, 2, [1, -2, 0.5, 0.3, 0.7, -1.1], [-0, 0.2]);
    const l3 = layer(2, 1, [1.5, -0.5], [-0]);
    const rows = [[1, 0, 1], [1, 0, 3], [1, 0, 0.5], [1, 0, -2], [1, 0, -5]];
    const plain = rows.map((r) => dense(l3, dense(l2, dense(l1, r, true), true), false)[0]);
    const got = scoreCandidates([l1, l2, l3], 2, rows);
    got.forEach((q, i) => expect(Object.is(q, plain[i])).toBe(true));
  });
});
