import type { Dense } from './weights';

// y = Wx + b (W row-major [outDim][inDim], as torch stores it), with optional ReLU. Math is in
// float64; the Python model runs float32, so results agree to about 1e-6.
export function dense(layer: Dense, x: ArrayLike<number>, relu: boolean): Float64Array {
  const { inDim, outDim, w, b } = layer;
  const out = new Float64Array(outDim);
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
  return rows.map((row) => {
    let h = Float64Array.from(shared);
    addColumns(first, row, obsDim, first.inDim, h);
    for (let o = 0; o < h.length; o++) if (h[o] < 0) h[o] = 0;
    rest.forEach((layer, k) => {
      h = dense(layer, h, k < rest.length - 1);
    });
    return h[0];
  });
}
