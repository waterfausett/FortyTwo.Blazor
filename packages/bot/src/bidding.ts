import { dense } from './mlp';
import { encodeHand } from './encode';
import { IS_DOUBLE } from './dominoes';
import type { BotWeights } from './weights';

const PASS = 0;
const PLUNGE = 169;
const HIGH_PROBE = 42;
const MARKS_BID = 84;
const HIGH_TRUMPS = [0, 1, 2, 3, 4, 5, 6, -1];
const LOW_TRUMPS = [-2, -3, -4];

export interface BidTable { points: number[][]; high: number[]; low: number[]; plunge: number | null }
export interface Option { bid: number; trump: number; pMake: number }
export interface BidContext { legal: number[]; partnerHolds: boolean; lastToBid: boolean }
export interface BidDecision { bid: number; trump: number | null; pMake: number | null }

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const marksFor = (bid: number) => (bid <= 42 ? 1 : Math.floor(bid / 42));
const ev = (o: Option) => marksFor(o.bid) * (2 * o.pMake - 1);

export function bidTable(w: BotWeights, hand: number[]): BidTable {
  let h: ArrayLike<number> = encodeHand(hand);
  for (const layer of w.bidBody) h = dense(layer, h, true);
  const logits = dense(w.pointsHead, h, false);
  const binary = Array.from(dense(w.binaryHead, h, false), sigmoid);
  const points: number[][] = [];
  for (let s = 0; s < 7; s++) {
    const z = Array.from(logits.slice(s * 14, s * 14 + 14));
    const m = Math.max(...z);
    const e = z.map((v) => Math.exp(v - m));
    const total = e.reduce((a, b) => a + b, 0);
    const p = e.map((v) => v / total);
    const atLeast = new Array<number>(14);
    let acc = 0;
    for (let k = 13; k >= 0; k--) atLeast[k] = acc += p[k];
    points.push(atLeast.slice(1, 13)); // P(make 30) ... P(make 41)
  }
  const doubles = hand.filter((d) => IS_DOUBLE[d]).length;
  return { points, high: binary.slice(0, 8), low: binary.slice(8, 11), plunge: doubles >= 4 ? binary[11] : null };
}

export function optionsFromTable(table: BidTable, legal: number[]): Option[] {
  const bids = legal.filter((b) => b !== PASS);
  const pointsBids = bids.filter((b) => b < HIGH_PROBE);
  const highBids = bids.filter((b) => b >= HIGH_PROBE && b !== PLUNGE);
  const options: Option[] = [];
  if (pointsBids.length) for (let t = 0; t < 7; t++) for (const b of pointsBids) options.push({ bid: b, trump: t, pMake: table.points[t][b - 30] });
  if (highBids.length) {
    HIGH_TRUMPS.forEach((t, i) => { for (const b of highBids) options.push({ bid: b, trump: t, pMake: table.high[i] }); });
    LOW_TRUMPS.forEach((t, i) => { for (const b of highBids) options.push({ bid: b, trump: t, pMake: table.low[i] }); });
  }
  if (bids.includes(PLUNGE)) {
    if (table.plunge === null) throw new Error('plunge is legal but the table has no plunge probability');
    options.push({ bid: PLUNGE, trump: -1, pMake: table.plunge });
  }
  return options;
}

export function chooseBid(
  options: Option[], ctx: BidContext, cfg: { makeThreshold: number; overbidPartnerThreshold: number },
): BidDecision {
  const best = new Map<number, Option>();
  for (const o of options) {
    if (!ctx.legal.includes(o.bid) || o.bid === PASS) continue;
    const cur = best.get(o.bid);
    if (cur === undefined || o.pMake > cur.pMake) best.set(o.bid, o);
  }
  const take = (bid: number): BidDecision => {
    const o = best.get(bid)!;
    return { bid: o.bid, trump: o.trump, pMake: o.pMake };
  };
  const passing: BidDecision = { bid: PASS, trump: null, pMake: null };
  const forced = !ctx.legal.includes(PASS);
  const forcedBid = (): BidDecision => {
    const lowest = Math.min(...ctx.legal.filter((b) => b !== PASS));
    return best.has(lowest) ? take(lowest) : { bid: lowest, trump: null, pMake: null };
  };
  const makeable = [...best.entries()].filter(([, o]) => o.pMake > cfg.makeThreshold).map(([b]) => b).sort((a, b) => a - b);

  if (ctx.partnerHolds) {
    const strong = [...best.entries()].filter(([, o]) => o.pMake >= cfg.overbidPartnerThreshold).map(([b]) => b);
    return strong.length ? take(Math.max(...strong)) : passing;
  }
  if (ctx.lastToBid) {
    if (makeable.length) {
      const lowest = makeable[0];
      const marks = makeable.filter((b) => b >= MARKS_BID);
      let richest: number | null = null;
      for (const b of marks) if (richest === null || ev(best.get(b)!) > ev(best.get(richest)!)) richest = b;
      return richest !== null && ev(best.get(richest)!) > ev(best.get(lowest)!) ? take(richest) : take(lowest);
    }
    return forced ? forcedBid() : passing;
  }
  if (makeable.length) return take(makeable[makeable.length - 1]);
  return forced ? forcedBid() : passing;
}
