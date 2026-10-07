import { describe, expect, it } from 'vitest';
import { buildView, encodeCandidates, encodeHand, toIndex, DOMINOES } from '../src/index';
import { fixtureHands } from './fixtures';
import { PLAYERS, applyStep, dominoFromId, startHand } from './replay';

const sparse = (row: Float64Array) => {
  const out: [number, number][] = [];
  row.forEach((v, i) => { if (v !== 0) out.push([i, Math.fround(v)]); });
  return out;
};

describe('encoders match features.py on every fixture decision', () => {
  it('domino indices follow Python order', () => {
    expect(DOMINOES.map((d) => d.id).slice(0, 8)).toEqual(['0/0', '0/1', '0/2', '0/3', '0/4', '0/5', '0/6', '1/1']);
    expect(toIndex(dominoFromId('6/6'))).toBe(27);
  });

  it('play encodings', () => {
    let checked = 0;
    for (const h of fixtureHands()) {
      let match = startHand(h);
      for (const s of h.steps) {
        if (s.phase === 'play' && s.features) {
          const view = buildView(match, PLAYERS[s.seat]);
          const rows = encodeCandidates(view, s.legal!.map((id) => toIndex(dominoFromId(id))));
          rows.forEach((row, k) => expect(sparse(row)).toEqual(s.features![k].map(([i, v]) => [i, Math.fround(v)])));
          checked++;
        }
        match = applyStep(match, s);
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('bid encodings', () => {
    for (const h of fixtureHands()) {
      let match = startHand(h);
      for (const s of h.steps) {
        if (s.phase === 'bid' && s.bidInput) {
          const hand = match.currentGame.hands.find((x) => x.playerId === PLAYERS[s.seat])!.dominoes.map(toIndex);
          expect(Array.from(encodeHand(hand), Math.fround)).toEqual(s.bidInput.map(Math.fround));
        }
        match = applyStep(match, s);
      }
    }
  });
});
