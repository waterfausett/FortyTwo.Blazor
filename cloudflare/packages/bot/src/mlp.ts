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

// Adds W[:, from:to] · x[from:to] into acc, skipping zero inputs (encodings are mostly zeros).
function addColumns(layer: Dense, x: ArrayLike<number>, from: number, to: number, acc: Float64Array): void {
  const { inDim, outDim, w } = layer;
  for (let i = from; i < to; i++) {
    const v = x[i];
    if (v === 0) continue;
    for (let o = 0; o < outDim; o++) acc[o] += w[o * inDim + i] * v;
  }
}

// The play network's Q for each candidate row. Every row shares the observation prefix
// [0, obsDim), so that slice of the first layer is computed once for all candidates.
export function scoreCandidates(play: Dense[], obsDim: number, rows: ArrayLike<number>[]): number[] {
  const [first, ...rest] = play;
  const shared = Float64Array.from(first.b);
  addColumns(first, rows[0], 0, obsDim, shared);
  // Two ping-pong buffers sized for the widest layer, reused across layers and candidates.
  const width = Math.max(...play.map((l) => l.outDim));
  let bufA = new Float64Array(width);
  let bufB = new Float64Array(width);
  return rows.map((row) => {
    const hidden = first.outDim;
    for (let o = 0; o < hidden; o++) bufA[o] = shared[o];
    addColumns(first, row, obsDim, first.inDim, bufA);
    for (let o = 0; o < hidden; o++) if (bufA[o] < 0) bufA[o] = 0;
    let cur = bufA;
    let nxt = bufB;
    for (let k = 0; k < rest.length; k++) {
      denseInto(rest[k], cur, k < rest.length - 1, nxt);
      [cur, nxt] = [nxt, cur];
    }
    return cur[0];
  });
}
