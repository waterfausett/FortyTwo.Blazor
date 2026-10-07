import type { Dense } from './weights';

// y = Wx + b (W row-major [outDim][inDim], as torch stores it), with optional ReLU. Math is in
// float64; the Python model runs float32, so results agree to about 1e-6.
export function dense(layer: Dense, x: ArrayLike<number>, relu: boolean): Float64Array {
  return denseInto(layer, x, relu, new Float64Array(layer.outDim));
}

// Same as dense, writing into a caller-owned buffer (must not alias x).
function denseInto(layer: Dense, x: ArrayLike<number>, relu: boolean, out: Float64Array): Float64Array {
  const { inDim, outDim, w, b } = layer;
  for (let o = 0; o < outDim; o++) {
    let s = b[o];
    const row = o * inDim;
    for (let i = 0; i < inDim; i++) s += w[row + i] * x[i];
    out[o] = relu && s < 0 ? 0 : s;
  }
  return out;
}

// Adds W[:, from:to] Â· x[from:to] into acc, skipping zero inputs (encodings are mostly zeros).
function addColumns(layer: Dense, x: ArrayLike<number>, from: number, to: number, acc: Float64Array): void {
  const { inDim, outDim, w } = layer;
  for (let i = from; i < to; i++) {
    const v = x[i];
    if (v === 0) continue;
    for (let o = 0; o < outDim; o++) acc[o] += w[o * inDim + i] * v;
  }
}

// Exact dot product of W's row o with x: bias first, then i = 0..inDim-1 in order.
function dot(w: Float32Array, row: number, inDim: number, bias: number, x: Float64Array): number {
  let s = bias;
  for (let i = 0; i < inDim; i++) s += w[row + i] * x[i];
  return s;
}

// One layer for every candidate, in blocks of up to four candidates with one scalar accumulator
// each, so each weight is read once per block. Inputs are ReLU outputs, mostly zeros, so only the
// indices where some candidate in the block is non-zero are visited (ascending). A skipped term is
// w * 0 = ±0 (weights are finite), and adding ±0 leaves any non-zero sum unchanged, so the sum
// equals the full bias-first, i-ordered sum except possibly in the sign of an exact zero; a sum
// that comes out exactly zero is redone in full, so results are bit-identical to denseInto.
function denseBlocked(layer: Dense, xs: Float64Array[], relu: boolean, outs: Float64Array[], idx: Int32Array): void {
  const inDim = layer.inDim;
  const outDim = layer.outDim;
  const w = layer.w;
  const b = layer.b;
  const n = xs.length;
  for (let k = 0; k < n; k += 4) {
    const m = n - k < 4 ? n - k : 4;
    const x0 = xs[k];
    const x1 = m > 1 ? xs[k + 1] : x0;
    const x2 = m > 2 ? xs[k + 2] : x0;
    const x3 = m > 3 ? xs[k + 3] : x0;
    let nnz = 0;
    for (let i = 0; i < inDim; i++) {
      if (x0[i] !== 0 || x1[i] !== 0 || x2[i] !== 0 || x3[i] !== 0) idx[nnz++] = i;
    }
    if (m === 4) {
      const y0 = outs[k], y1 = outs[k + 1], y2 = outs[k + 2], y3 = outs[k + 3];
      for (let o = 0; o < outDim; o++) {
        const bo = b[o];
        let s0 = bo, s1 = bo, s2 = bo, s3 = bo;
        const row = o * inDim;
        for (let j = 0; j < nnz; j++) {
          const i = idx[j];
          const wi = w[row + i];
          s0 += wi * x0[i];
          s1 += wi * x1[i];
          s2 += wi * x2[i];
          s3 += wi * x3[i];
        }
        if (s0 === 0) s0 = dot(w, row, inDim, bo, x0);
        if (s1 === 0) s1 = dot(w, row, inDim, bo, x1);
        if (s2 === 0) s2 = dot(w, row, inDim, bo, x2);
        if (s3 === 0) s3 = dot(w, row, inDim, bo, x3);
        y0[o] = relu && s0 < 0 ? 0 : s0;
        y1[o] = relu && s1 < 0 ? 0 : s1;
        y2[o] = relu && s2 < 0 ? 0 : s2;
        y3[o] = relu && s3 < 0 ? 0 : s3;
      }
    } else {
      for (let c = 0; c < m; c++) {
        const x = xs[k + c];
        const y = outs[k + c];
        for (let o = 0; o < outDim; o++) {
          const bo = b[o];
          let s = bo;
          const row = o * inDim;
          for (let j = 0; j < nnz; j++) {
            const i = idx[j];
            s += w[row + i] * x[i];
          }
          if (s === 0) s = dot(w, row, inDim, bo, x);
          y[o] = relu && s < 0 ? 0 : s;
        }
      }
    }
  }
}

// The play network's Q for each candidate row. Every row shares the observation prefix
// [0, obsDim), so that slice of the first layer is computed once for all candidates.
export function scoreCandidates(play: Dense[], obsDim: number, rows: ArrayLike<number>[]): number[] {
  const first = play[0];
  const hidden = first.outDim;
  const shared = new Float64Array(hidden);
  for (let o = 0; o < hidden; o++) shared[o] = first.b[o];
  addColumns(first, rows[0], 0, obsDim, shared);
  let width = 0;
  for (const l of play) if (l.outDim > width) width = l.outDim;
  let cur: Float64Array[] = [];
  let nxt: Float64Array[] = [];
  for (const row of rows) {
    const a = new Float64Array(width);
    for (let o = 0; o < hidden; o++) a[o] = shared[o];
    addColumns(first, row, obsDim, first.inDim, a);
    for (let o = 0; o < hidden; o++) if (a[o] < 0) a[o] = 0;
    cur.push(a);
    nxt.push(new Float64Array(width));
  }
  const idx = new Int32Array(width);
  for (let k = 1; k < play.length; k++) {
    denseBlocked(play[k], cur, k < play.length - 1, nxt, idx);
    const t = cur; cur = nxt; nxt = t;
  }
  return cur.map((a) => a[0]);
}
