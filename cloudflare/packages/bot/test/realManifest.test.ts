import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BID_INPUT_LAYOUT, FORMAT, PLAY_INPUT_DIM } from '../src/index';

// The shipped manifest is plain git (only bot.bin is LFS), so CI can check it without the weights:
// a retrain with new features but no TS update fails here, not in production.
const path = new URL('../../../apps/web/public/models/bot.json', import.meta.url);

describe('shipped model manifest', () => {
  it.runIf(existsSync(path))('declares the layouts this bot implements', () => {
    const m = JSON.parse(readFileSync(path, 'utf8'));
    expect(m.format).toBe(FORMAT);
    expect(m.playInputDim).toBe(PLAY_INPUT_DIM);
    expect(m.bidInputLayout).toBe(BID_INPUT_LAYOUT);
  });
});
