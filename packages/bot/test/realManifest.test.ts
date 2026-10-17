import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BID_INPUT_LAYOUT, FORMAT, PLAY_INPUT_DIM } from '../src/index';

// The shipped manifest is plain git (only bot.bin is LFS), so CI can check it without the weights:
// a retrain with new features but no TS update fails here, not in production.
const path = new URL('../../../apps/web/public/models/bot.json', import.meta.url);
const binPath = new URL('../../../apps/web/public/models/bot.bin', import.meta.url);

describe('shipped model manifest', () => {
  it.runIf(existsSync(path))('declares the layouts this bot implements', () => {
    const m = JSON.parse(readFileSync(path, 'utf8'));
    expect(m.format).toBe(FORMAT);
    expect(m.playInputDim).toBe(PLAY_INPUT_DIM);
    expect(m.bidInputLayout).toBe(BID_INPUT_LAYOUT);
  });

  // The manifest's sha256 must be bot.bin's. Without LFS (CI) bot.bin is a pointer naming the
  // real file's sha256 as its oid; with LFS it's the weights themselves, hashed here.
  it.runIf(existsSync(path) && existsSync(binPath))("records bot.bin's sha256", () => {
    const { sha256 } = JSON.parse(readFileSync(path, 'utf8'));
    const bin = readFileSync(binPath);
    const pointer = bin.subarray(0, 24).toString('latin1') === 'version https://git-lfs.';
    const actual = pointer
      ? /^oid sha256:([0-9a-f]{64})$/m.exec(bin.toString('utf8'))?.[1]
      : createHash('sha256').update(bin).digest('hex');
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(actual).toBe(sha256);
  });
});
