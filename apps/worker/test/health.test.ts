import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';

describe('health', () => {
  it('GET /health returns ok', async () => {
    const res = await SELF.fetch('https://example.com/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
