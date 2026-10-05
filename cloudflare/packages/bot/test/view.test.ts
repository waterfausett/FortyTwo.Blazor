import { describe, expect, it } from 'vitest';
import { Bid, Suit, isLow } from '@fortytwo/rules';
import { buildView } from '../src/index';
import { fixtureHands } from './fixtures';
import { PLAYERS, applyStep, startHand } from './replay';

describe('buildView', () => {
  it('assigns seats in a Low trick, skipping the bidder\'s partner', () => {
    const h = fixtureHands().find((x) => x.steps.some((s) => s.phase === 'trump' && isLow(s.action as Suit)))!;
    let match = startHand(h);
    let checked = false;
    for (const s of h.steps) {
      if (s.phase === 'play' && match.currentGame.trump !== null) {
        const view = buildView(match, PLAYERS[s.seat]);
        expect(view.sitsOut).toBe((view.bidder + 2) % 4);
        expect(view.trick.every(([seat]) => seat !== view.sitsOut)).toBe(true);
        expect(s.seat).not.toBe(view.sitsOut);
        checked = true;
      }
      match = applyStep(match, s);
    }
    expect(checked).toBe(true);
  });

  it('the plunge namer leads the first trick', () => {
    const h = fixtureHands().find((x) => x.steps.some((s) => s.phase === 'bid' && s.action === Bid.Plunge))!;
    let match = startHand(h);
    for (const s of h.steps) {
      if (s.phase === 'play') {
        const view = buildView(match, PLAYERS[s.seat]);
        expect(s.seat).toBe((view.bidder + 2) % 4);
        break;
      }
      match = applyStep(match, s);
    }
  });
});
