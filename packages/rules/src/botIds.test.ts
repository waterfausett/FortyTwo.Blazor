import { describe, expect, it } from 'vitest';
import { BOT_MARK, botDisplayName, isBot, mintBotId, withoutBotMark } from './botIds';

describe('isBot', () => {
  it('accepts bare and match-prefixed bot ids', () => {
    expect(['bot-1', 'bot-3', 'abc-123_bot-2'].map(isBot)).toEqual([true, true, true]);
  });

  it('rejects everything else, including ids that merely end in bot-N', () => {
    expect(['p1', 'auth0|abc', 'bot-4', 'bot-0', 'abot-1', '_bot-1', 'bot-1x'].map(isBot)).toEqual(
      [false, false, false, false, false, false, false]
    );
  });
});

describe('botDisplayName', () => {
  it('ends every bot name with the mark', () => {
    expect(botDisplayName('m1_bot-1').endsWith(` ${BOT_MARK}`)).toBe(true);
  });

  it('gives the three bots at a table three different names', () => {
    for (const seed of ['', 'm1', 'm2', 'a-much-longer-match-id']) {
      const prefix = seed === '' ? '' : `${seed}_`;
      const names = [1, 2, 3].map((n) => botDisplayName(`${prefix}bot-${n}`));
      expect(new Set(names).size).toBe(3);
    }
  });

  it('is the same every time for an id, and varies from match to match', () => {
    expect(botDisplayName('m1_bot-1')).toBe(botDisplayName('m1_bot-1'));
    const casts = new Set(Array.from({ length: 20 }, (_, i) => botDisplayName(`m${i}_bot-1`)));
    expect(casts.size).toBeGreaterThan(5);
  });

  it('names legacy bare ids with a fixed set', () => {
    expect(botDisplayName('bot-1')).toBe(botDisplayName('bot-1'));
    expect(botDisplayName('bot-1')).not.toBe(botDisplayName('bot-2'));
  });
});

describe('mintBotId', () => {
  it('seeds the first bot with the match id', () => {
    expect(mintBotId('m1', ['p1'])).toBe('m1_bot-1');
  });

  it('takes the first free number and the prefix the table already has', () => {
    expect(mintBotId('m2', ['p1', 'm1_bot-1', 'm1_bot-3'])).toBe('m1_bot-2');
  });

  it('stays bare at a table of bare bots', () => {
    expect(mintBotId('m2', ['p1', 'bot-1'])).toBe('bot-2');
  });

  it('is undefined with all three seated', () => {
    expect(mintBotId('m1', ['m1_bot-1', 'm1_bot-2', 'm1_bot-3'])).toBeUndefined();
  });

  it('never names two bots at a table the same', () => {
    const seated: string[] = ['p1'];
    for (let i = 0; i < 3; i++) seated.push(mintBotId('m9', seated)!);
    expect(new Set(seated.filter(isBot).map(botDisplayName)).size).toBe(3);
  });
});

describe('withoutBotMark', () => {
  it('removes the mark and tidies what is left', () => {
    expect(withoutBotMark('Ada 🤖')).toBe('Ada');
    expect(withoutBotMark('🤖  Ada  🤖')).toBe('Ada');
    expect(withoutBotMark('Sam')).toBe('Sam');
    expect(withoutBotMark('🤖')).toBe('');
  });
});
