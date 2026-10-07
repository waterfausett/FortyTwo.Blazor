import { describe, expect, it } from 'vitest';
import { BOT_IDS, botDisplayName } from './botIds';

describe('botDisplayName', () => {
  it('names each bot by its number', () => {
    expect(BOT_IDS.map(botDisplayName)).toEqual(['Bot 1', 'Bot 2', 'Bot 3']);
  });
});
