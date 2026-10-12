import { describe, expect, it } from 'vitest';
import { LOW_TRUMPS, WINNING_SCORE, createDomino, dominoValue } from '@fortytwo/rules';
import { DOUBLES_DETAIL, HOW_TO_PLAY, shouldOfferHowToPlay, type HowToPlayBlock } from './howToPlay';

const blocks = (id: string): HowToPlayBlock[] => HOW_TO_PLAY.find((s) => s.id === id)!.blocks;
const allText = HOW_TO_PLAY.flatMap((s) =>
  s.blocks.flatMap((b) => (b.kind === 'text' ? [b.text] : b.kind === 'list' ? b.items : [b.caption]))
).join('\n');
const key = (d: { top: number; bottom: number }) => [d.top, d.bottom].sort().join('-');

describe('HOW_TO_PLAY', () => {
  it('has the sections in order, each with a title and blocks', () => {
    expect(HOW_TO_PLAY.map((s) => s.id)).toEqual([
      'game',
      'suits',
      'doubles',
      'counting',
      'bidding',
      'follow_me',
      'low',
      'tricks',
      'scoring',
    ]);
    for (const s of HOW_TO_PLAY) {
      expect(s.title).not.toBe('');
      expect(s.blocks.length).toBeGreaterThan(0);
    }
  });

  it('shows exactly the counters, and they add up to 35', () => {
    const shown = blocks('counting').flatMap((b) => (b.kind === 'dominoes' ? b.dominoes : []));
    const all = [];
    for (let top = 0; top <= 6; top++) for (let bottom = 0; bottom <= top; bottom++) all.push(createDomino(top, bottom));
    const counters = all.filter((d) => dominoValue(d) > 0);
    expect(shown.map(key).sort()).toEqual(counters.map(key).sort());
    expect(shown.reduce((sum, d) => sum + dominoValue(createDomino(d.top, d.bottom)), 0)).toBe(35);
  });

  it('says a Plunge can call Follow Me but never Low', () => {
    const plunge = blocks('bidding').flatMap((b) => (b.kind === 'list' ? b.items : [])).find((i) => i.startsWith('Plunge'))!;
    expect(plunge).toContain('Follow Me');
    expect(plunge).toContain('never Low');
  });

  it('names the match target from the rules engine', () => {
    expect(allText).toContain(`first team to ${WINNING_SCORE} marks`);
  });

  it('describes every Low doubles rule in the shared wording', () => {
    for (const suit of LOW_TRUMPS) expect(allText).toContain(DOUBLES_DETAIL[suit]);
  });
});

describe('shouldOfferHowToPlay', () => {
  it('offers the rules only when the profile says they have not been seen', () => {
    expect(shouldOfferHowToPlay({ seenHowToPlay: false })).toBe(true);
    expect(shouldOfferHowToPlay({ seenHowToPlay: true })).toBe(false);
    // A worker that doesn't know the setting yet, or a profile still loading.
    expect(shouldOfferHowToPlay({})).toBe(false);
    expect(shouldOfferHowToPlay(undefined)).toBe(false);
  });
});
