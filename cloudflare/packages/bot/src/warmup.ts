// JIT warm-up. In a fresh isolate V8 runs the bot in its interpreter at first, and the first play
// decision with the real network costs 13-25 ms of CPU (Node; workerd runs the same V8) - over
// the Workers Free plan's 10 ms per invocation, and a CPU kill can't be caught, so the simple-bot
// fallback never runs. V8 tiers a function up by how much of it has run and with which types
// (call counts, loop back-edges, type feedback), not by the size of the matrices it ran on. So
// warmUp makes decisions with a tiny synthetic network: the same code paths with the same types
// (a manifest and Float32Array views built by loadWeights itself, Float64Array activations,
// candidate blocks of 1-4), so the type feedback the real network meets later is the same and
// stays monomorphic. It costs ~9 ms in a fresh Node process, most of it the one-time compiling of
// the bot's and the rules engine's code, which the first real decisions would otherwise pay.
import {
  createDomino, createTrick, gameWinningTeam, placeBid, playDomino, setTrump, teamForPosition, type Domino, type MatchState,
} from '@fortytwo/rules';
import { bidTable } from './bidding';
import { createBot } from './bot';
import { toIndex } from './dominoes';
import { OBS_DIM, encodeCandidates } from './encode';
import { scoreCandidates } from './mlp';
import { buildView } from './view';
import { PLAY_INPUT_DIM, loadWeights, type Manifest } from './weights';

const HIDDEN = 8;
const PLAYERS = ['w0', 'w1', 'w2', 'w3'];
const PLAYS = 8; // two tricks: enough for buildView to replay a finished trick
const KERNEL_REPS = 5;

// The same shapes as the real network (5 play layers, 3 bid body layers, the two bid heads), only
// HIDDEN wide, filled from a fixed generator so every isolate warms up on the same hand.
function syntheticWeights() {
  const layers: [string, number, number][] = [
    ['play.0', PLAY_INPUT_DIM, HIDDEN], ['play.1', HIDDEN, HIDDEN], ['play.2', HIDDEN, HIDDEN], ['play.3', HIDDEN, HIDDEN],
    ['play.4', HIDDEN, 1], ['bid.0', 36, HIDDEN], ['bid.1', HIDDEN, HIDDEN], ['bid.2', HIDDEN, HIDDEN],
    ['bid.points', HIDDEN, 98], ['bid.binary', HIDDEN, 12],
  ];
  const tensors: Manifest['tensors'] = {};
  let offset = 0;
  for (const [name, inDim, outDim] of layers) {
    tensors[`${name}.weight`] = { shape: [outDim, inDim], offset };
    offset += outDim * inDim * 4;
    tensors[`${name}.bias`] = { shape: [outDim], offset };
    offset += outDim * 4;
  }
  const data = new Float32Array(offset / 4);
  let seed = 42;
  for (let i = 0; i < data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    data[i] = seed / 2 ** 32; // in [-0.5, 0.5)
  }
  const ref = (name: string) => ({ weight: `${name}.weight`, bias: `${name}.bias` });
  const manifest: Manifest = {
    format: 1, totalBytes: offset, sha256: '', playInputDim: PLAY_INPUT_DIM, bidInputLayout: 1,
    makeThreshold: 0.6, overbidPartnerThreshold: 0.9, tensors,
    play: { layers: ['play.0', 'play.1', 'play.2', 'play.3', 'play.4'].map(ref) },
    bid: { body: ['bid.0', 'bid.1', 'bid.2'].map(ref), pointsHead: ref('bid.points'), binaryHead: ref('bid.binary') },
    provenance: { warmUp: true },
  };
  return loadWeights(manifest, data.buffer);
}

// A dealt hand, built directly rather than with createMatch/takeSeat (crypto.randomUUID).
function deal(): MatchState {
  const order: Domino[] = [];
  for (let lo = 0; lo <= 6; lo++) for (let hi = lo; hi <= 6; hi++) order.push(createDomino(lo, hi));
  let seed = 7;
  for (let i = order.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return {
    id: 'warm-up', createdOn: '', updatedOn: '', games: {}, winningTeam: null,
    players: PLAYERS.map((playerId, position) => ({ playerId, position, ready: false })),
    currentGame: {
      id: 'warm-up', name: 'Game 1', firstActionBy: PLAYERS[0], bid: null, biddingPlayerId: null, trump: null,
      currentPlayerId: PLAYERS[0], currentTrick: createTrick(), tricks: [],
      hands: PLAYERS.map((playerId, seat) => ({
        playerId, team: teamForPosition(seat), dominoes: order.slice(seat * 7, seat * 7 + 7), bid: null,
      })),
    },
  };
}

// Bids, names trump and plays two tricks of one synthetic hand through the bot (compiling all of
// a real decision's code, with real type feedback), then runs the network kernels a few more
// times on their own - the cheapest way to get their hot loops optimized. Returns the number of
// plays made, for the test.
export function warmUp(): number {
  const w = syntheticWeights();
  const bot = createBot(w);
  let m = deal();
  let held: number[] = [];
  let rows: Float64Array[] = [];
  let plays = 0;
  while (plays < PLAYS) {
    const game = m.currentGame;
    const id = game.currentPlayerId!;
    if (game.hands.some((h) => h.bid === null)) m = placeBid(m, id, bot.decideBid(m, id));
    else if (game.trump === null) m = setTrump(m, id, bot.decideTrump(m, id));
    else if (gameWinningTeam(game) !== null) break;
    else {
      if (plays === 0) {
        // The opening lead: all seven dominoes are legal, so seven candidate rows to reuse below.
        held = game.hands.find((h) => h.playerId === id)!.dominoes.map(toIndex);
        rows = encodeCandidates(buildView(m, id), held);
      }
      m = playDomino(m, id, bot.decideDomino(m, id));
      plays++;
    }
  }
  for (let r = 0; r < KERNEL_REPS; r++) {
    for (let k = 1; k <= rows.length; k++) scoreCandidates(w.play, OBS_DIM, rows.slice(0, k));
    bidTable(w, held);
  }
  return plays;
}
