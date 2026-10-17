// The exported bot (ml/src/fortytwo_ml/export.py): one little-endian float32 blob and a JSON
// manifest naming each tensor's shape and byte offset. Tensors become Float32Array views over the
// blob, with no copying or parsing, so loading is cheap enough for the Workers Free plan.
export const FORMAT = 1;
export const PLAY_INPUT_DIM = 363;
export const BID_INPUT_LAYOUT = 1;
const LFS_HEADER = 'version https://git-lfs';

export class WeightsError extends Error {}

export interface DenseRef { weight: string; bias: string }
export interface Manifest {
  format: number;
  totalBytes: number;
  sha256: string;
  playInputDim: number;
  bidInputLayout: number;
  makeThreshold: number;
  overbidPartnerThreshold: number;
  tensors: Record<string, { shape: number[]; offset: number }>;
  play: { layers: DenseRef[] };
  bid: { body: DenseRef[]; pointsHead: DenseRef; binaryHead: DenseRef };
  provenance: Record<string, unknown>;
}
export interface Dense { inDim: number; outDim: number; w: Float32Array; b: Float32Array }
export interface BotWeights { manifest: Manifest; play: Dense[]; bidBody: Dense[]; pointsHead: Dense; binaryHead: Dense }

export function loadWeights(raw: unknown, bin: ArrayBuffer): BotWeights {
  if (typeof raw !== 'object' || raw === null || !('tensors' in raw)) {
    throw new WeightsError('bot.json is not a bot manifest');
  }
  const manifest = raw as Manifest;
  if (manifest.format !== FORMAT) throw new WeightsError(`model format ${manifest.format}; this bot reads ${FORMAT}`);
  if (manifest.playInputDim !== PLAY_INPUT_DIM) {
    throw new WeightsError(`playInputDim ${manifest.playInputDim}; this bot's encoder makes ${PLAY_INPUT_DIM}`);
  }
  if (manifest.bidInputLayout !== BID_INPUT_LAYOUT) {
    throw new WeightsError(`bidInputLayout ${manifest.bidInputLayout}; this bot implements ${BID_INPUT_LAYOUT}`);
  }
  const head = new TextDecoder().decode(new Uint8Array(bin, 0, Math.min(bin.byteLength, LFS_HEADER.length)));
  if (head === LFS_HEADER) throw new WeightsError('bot.bin is a Git LFS pointer, not the weights (check out with LFS)');
  if (bin.byteLength !== manifest.totalBytes) {
    throw new WeightsError(`bot.bin is ${bin.byteLength} bytes; the manifest says ${manifest.totalBytes}`);
  }

  const tensor = (name: string) => {
    const t = manifest.tensors[name];
    if (!t) throw new WeightsError(`manifest names tensor ${name} but doesn't describe it`);
    const n = t.shape.reduce((a, b) => a * b, 1);
    if (t.offset % 4 !== 0 || t.offset + n * 4 > bin.byteLength) throw new WeightsError(`tensor ${name} is out of bounds`);
    return { shape: t.shape, data: new Float32Array(bin, t.offset, n) };
  };
  const dense = (ref: DenseRef): Dense => {
    const w = tensor(ref.weight);
    const b = tensor(ref.bias);
    if (w.shape.length !== 2 || b.shape.length !== 1 || b.shape[0] !== w.shape[0]) {
      throw new WeightsError(`layer ${ref.weight} has inconsistent shapes`);
    }
    return { outDim: w.shape[0], inDim: w.shape[1], w: w.data, b: b.data };
  };
  const chain = (layers: Dense[], inDim: number, what: string) => {
    let width = inDim;
    for (const l of layers) {
      if (l.inDim !== width) throw new WeightsError(`${what}: a layer takes ${l.inDim} inputs, expected ${width}`);
      width = l.outDim;
    }
    return width;
  };

  // scoreCandidates applies ReLU after the first layer, so a single linear layer can't be run as is.
  if (manifest.play.layers.length < 2) throw new WeightsError('play network must have at least two layers');
  const play = manifest.play.layers.map(dense);
  if (chain(play, PLAY_INPUT_DIM, 'play network') !== 1) throw new WeightsError('play network must output one value');
  const bidBody = manifest.bid.body.map(dense);
  const width = chain(bidBody, 36, 'bid network');
  const pointsHead = dense(manifest.bid.pointsHead);
  const binaryHead = dense(manifest.bid.binaryHead);
  if (pointsHead.inDim !== width || pointsHead.outDim !== 7 * 14) throw new WeightsError('bid points head has the wrong shape');
  if (binaryHead.inDim !== width || binaryHead.outDim !== 12) throw new WeightsError('bid binary head has the wrong shape');
  return { manifest, play, bidBody, pointsHead, binaryHead };
}
