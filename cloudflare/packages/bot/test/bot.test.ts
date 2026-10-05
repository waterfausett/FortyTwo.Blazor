import { describe, expect, it } from 'vitest';
import { gameWinningTeam } from '@fortytwo/rules';
import { bidTable, createBot, legalPlays, toIndex } from '../src/index';
import { fixtureHands, fixtureWeights, tolerantEqual } from './fixtures';
import { PLAYERS, applyStep, startHand } from './replay';

describe("the TS bot makes the Python bot's decisions", () => {
  const w = fixtureWeights();
  const bot = createBot(w);

  it('replays every fixture hand', () => {
    const counts = { bid: 0, trump: 0, play: 0 };
    for (const h of fixtureHands()) {
      let match = startHand(h);
      for (const s of h.steps) {
        const id = PLAYERS[s.seat];
        if (!s.scripted) {
          if (s.phase === 'bid') {
            const hand = match.currentGame.hands.find((x) => x.playerId === id)!.dominoes.map(toIndex);
            const t = bidTable(w, hand);
            t.points.flat().forEach((p, i) => expect(tolerantEqual(p, s.table!.points.flat()[i])).toBe(true));
            t.high.forEach((p, i) => expect(tolerantEqual(p, s.table!.high[i])).toBe(true));
            t.low.forEach((p, i) => expect(tolerantEqual(p, s.table!.low[i])).toBe(true));
            expect(t.plunge === null).toBe(s.table!.plunge === null);
            expect(bot.decideBid(match, id)).toBe(s.action);
            counts.bid++;
          } else if (s.phase === 'trump') {
            expect(bot.decideTrump(match, id)).toBe(s.action);
            counts.trump++;
          } else {
            expect(bot.decideDomino(match, id).id).toBe(s.action);
            counts.play++;
          }
        }
        match = applyStep(match, s);
      }
    }
    expect(counts.bid).toBeGreaterThan(300);
    expect(counts.trump).toBeGreaterThan(50);
    expect(counts.play).toBeGreaterThan(2000);
  });

  it('plays first legal once the hand is decided', () => {
    const h = fixtureHands().find((x) => x.steps.filter((s) => s.phase === 'play').length < 24)!;
    let match = startHand(h);
    for (const s of h.steps) match = applyStep(match, s);
    expect(gameWinningTeam(match.currentGame)).not.toBeNull();
    const id = match.currentGame.currentPlayerId!;
    const noInference = createBot({ ...w, play: [] });
    expect(noInference.decideDomino(match, id)).toBe(legalPlays(match.currentGame, id)[0]);
  });
});
