// A port of ml/src/fortytwo_ml/features.py (play) and bidding/model.encode_hands (bid). Layouts,
// orders and scalings must match exactly: test/encode.test.ts checks every fixture decision.
import { getSuit, getSuitValue, isOfSuit, type Suit } from '@fortytwo/rules';
import { DOMINOES, FULL_MASK, IS_DOUBLE, VALUE } from './dominoes';
import type { BotView } from './view';

export const HAND = 0;
export const PLAYED = HAND + 28;
export const TRICK = PLAYED + 4 * 28;
export const LED = TRICK + 4 * 28;
export const TRUMP = LED + 9;
export const BID = TRUMP + 11;
export const BIDDER = BID + 20;
export const PLUNGE_FLAG = BIDDER + 4;
export const SITS_OUT = PLUNGE_FLAG + 1;
export const VOIDS = SITS_OUT + 1;
export const SCALARS = VOIDS + 24;
export const OBS_DIM = SCALARS + 3;
const ACTION_ONEHOT = 28;
export const INPUT_DIM = OBS_DIM + ACTION_ONEHOT + 10;
const [A_IS_TRUMP, A_IS_DOUBLE, A_COUNT, A_FOLLOWS, A_RANK, A_WINS_NOW, A_OVERTAKES_PARTNER, A_BOSS, A_TRICK_POINTS, A_CLOSES] =
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const MAX_RANK = 18;
export const ALL_TRUMPS = [0, 1, 2, 3, 4, 5, 6, -1, -2, -3, -4];
export const CONTRACT_BIDS = [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 84, 126, 168, 169, 210, 252, 294];
const PLUNGE = 169;

const rank = (d: number, led: number, trump: number) => getSuitValue(DOMINOES[d], led as Suit, trump as Suit);
const isTrump = (d: number, trump: number) => trump >= 0 && trump <= 6 && isOfSuit(DOMINOES[d], trump as Suit);

function bits(x: Float64Array, offset: number, mask: number): void {
  for (let d = 0; d < 28; d++) if ((mask >>> d) & 1) x[offset + d] = 1;
}

function observation(v: BotView): Float64Array {
  const x = new Float64Array(INPUT_DIM);
  const rel = (s: number) => (s - v.seat + 4) % 4;
  for (const d of v.hand) x[HAND + d] = 1;
  for (let s = 0; s < 4; s++) bits(x, PLAYED + rel(s) * 28, v.played[s]);
  for (const [s, d] of v.trick) x[TRICK + rel(s) * 28 + d] = 1;
  x[LED + (v.led === null ? 8 : v.led)] = 1;
  x[TRUMP + ALL_TRUMPS.indexOf(v.trump)] = 1;
  x[BID + CONTRACT_BIDS.indexOf(v.highBid)] = 1;
  x[BIDDER + rel(v.bidder)] = 1;
  x[PLUNGE_FLAG] = v.highBid === PLUNGE ? 1 : 0;
  x[SITS_OUT] = v.sitsOut === (v.seat + 2) % 4 ? 1 : 0;
  for (let s = 0; s < 4; s++) {
    if (s === v.seat) continue;
    for (let led = 0; led < 8; led++) if ((v.voids[s] >>> led) & 1) x[VOIDS + (rel(s) - 1) * 8 + led] = 1;
  }
  const team = v.seat % 2;
  x[SCALARS] = v.points[team] / 42;
  x[SCALARS + 1] = v.points[1 - team] / 42;
  x[SCALARS + 2] = v.tricks / 7;
  return x;
}

export function encodeCandidates(v: BotView, legal: number[]): Float64Array[] {
  const obs = observation(v);
  const { trump, led } = v;
  let bestSeat: number | null = null;
  let bestRank = 0;
  if (v.trick.length > 0) {
    let best = 0;
    const ranks = v.trick.map(([, d]) => rank(d, led!, trump));
    for (let i = 1; i < ranks.length; i++) if (ranks[i] > ranks[best]) best = i;
    bestSeat = v.trick[best][0];
    bestRank = ranks[best];
  }
  let seen = 0;
  for (const d of v.hand) seen |= 1 << d;
  for (const m of v.played) seen |= m;
  const unseen = FULL_MASK & ~seen;
  const table = v.trick.reduce((sum, [, d]) => sum + VALUE[d], 0);
  const size = v.sitsOut === null ? 4 : 3;
  const f = OBS_DIM + ACTION_ONEHOT;

  return legal.map((d) => {
    const row = Float64Array.from(obs);
    row[OBS_DIM + d] = 1;
    row[f + A_IS_TRUMP] = isTrump(d, trump) ? 1 : 0;
    row[f + A_IS_DOUBLE] = IS_DOUBLE[d] ? 1 : 0;
    row[f + A_COUNT] = VALUE[d] / 10;
    row[f + A_TRICK_POINTS] = (table + VALUE[d] + 1) / 42;
    if (led !== null) {
      const r = rank(d, led, trump);
      const wins = r > bestRank;
      row[f + A_FOLLOWS] = isOfSuit(DOMINOES[d], led as Suit, trump as Suit) ? 1 : 0;
      row[f + A_RANK] = r > -1 ? (r + 1) / MAX_RANK : 0;
      row[f + A_WINS_NOW] = wins ? 1 : 0;
      row[f + A_OVERTAKES_PARTNER] = wins && bestSeat === (v.seat + 2) % 4 ? 1 : 0;
      row[f + A_CLOSES] = v.trick.length + 1 === size ? 1 : 0;
    } else {
      const own = getSuit(DOMINOES[d], trump as Suit);
      const r = rank(d, own, trump);
      row[f + A_RANK] = (r + 1) / MAX_RANK;
      let outranked = false;
      for (let u = 0; u < 28 && !outranked; u++) {
        if ((unseen >>> u) & 1 && isOfSuit(DOMINOES[u], own, trump as Suit) && rank(u, own, trump) > r) outranked = true;
      }
      row[f + A_BOSS] = outranked ? 0 : 1;
    }
    return row;
  });
}

// BidNet's input (bidding/model.encode_hands): 28 domino bits, dominoes per suit / 7, doubles / 7.
export function encodeHand(hand: number[]): Float64Array {
  const x = new Float64Array(36);
  const perSuit = [0, 0, 0, 0, 0, 0, 0];
  let doubles = 0;
  for (const d of hand) {
    x[d] = 1;
    const { top, bottom } = DOMINOES[d];
    for (let s = 0; s < 7; s++) if (top === s || bottom === s) perSuit[s]++;
    if (top === bottom) doubles++;
  }
  // Count, then divide once, as encode_hands does, so the values match its float32 exactly.
  perSuit.forEach((n, s) => { x[28 + s] = n / 7; });
  x[35] = doubles / 7;
  return x;
}
