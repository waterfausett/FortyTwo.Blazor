import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeOscillator {
  frequency = { setValueAtTime: vi.fn() };
  type = '';
  connect = vi.fn((node: unknown) => node);
  start = vi.fn();
  stop = vi.fn();
}

class FakeGain {
  gain = { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  connect = vi.fn((node: unknown) => node);
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = 'suspended';
  currentTime = 0;
  destination = {};
  oscillators: FakeOscillator[] = [];
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createOscillator(): FakeOscillator {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
  createGain(): FakeGain {
    return new FakeGain();
  }
}

// chime.ts keeps one AudioContext for the page, so each test loads a fresh copy of the module.
async function loadChime() {
  vi.resetModules();
  return import('./chime');
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('playChime', () => {
  it('plays two notes', async () => {
    const { playChime } = await loadChime();
    playChime();
    const [context] = FakeAudioContext.instances;
    expect(context.oscillators).toHaveLength(2);
    for (const oscillator of context.oscillators) expect(oscillator.start).toHaveBeenCalled();
  });

  it('reuses one audio context', async () => {
    const { playChime } = await loadChime();
    playChime();
    playChime();
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('does nothing where the browser has no Web Audio', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const { playChime } = await loadChime();
    expect(() => playChime()).not.toThrow();
  });
});

describe('unlockChimeOnGesture', () => {
  it('wakes the audio on the first click, so a later chime can play unattended', async () => {
    const { playChime, unlockChimeOnGesture } = await loadChime();
    unlockChimeOnGesture();
    expect(FakeAudioContext.instances).toHaveLength(0);

    window.dispatchEvent(new Event('pointerdown'));
    const [context] = FakeAudioContext.instances;
    expect(context.resume).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('keydown'));
    expect(context.resume).toHaveBeenCalledTimes(1);
    playChime();
    expect(FakeAudioContext.instances).toHaveLength(1);
  });
});
