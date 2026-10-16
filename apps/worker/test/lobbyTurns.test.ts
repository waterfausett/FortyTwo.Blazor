import { describe, it, expect } from 'vitest';
import { withTimeout } from '../src/lobbyTurns';

describe('withTimeout', () => {
  it('passes a prompt answer through', async () => {
    expect(await withTimeout(Promise.resolve(7), 50)).toBe(7);
  });

  it('gives null for an answer that comes too late', async () => {
    const late = new Promise<number>((resolve) => setTimeout(() => resolve(7), 200));
    expect(await withTimeout(late, 10)).toBeNull();
  });

  it('gives null for a failure', async () => {
    expect(await withTimeout(Promise.reject(new Error('down')), 50)).toBeNull();
  });
});
