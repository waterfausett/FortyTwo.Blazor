import { DEV_BYPASS, devApi } from '../devBypass';

describe('the dev bypass', () => {
  it('is off unless EXPO_PUBLIC_DEV_BYPASS turns it on', () => {
    expect(process.env.EXPO_PUBLIC_DEV_BYPASS).toBeUndefined();
    expect(DEV_BYPASS).toBe(false);
  });

  it('answers the lobby from canned data', async () => {
    const page = await devApi.listMatches('Joinable');
    expect(page.matches.length).toBeGreaterThan(0);
    expect(page.matches.every((m) => m.playerCount < 4)).toBe(true);
  });

  it('keeps a profile change for the session', async () => {
    await devApi.patchProfile({ displayName: 'Dev' });
    expect((await devApi.getProfile()).displayName).toBe('Dev');
  });

  it("says so for anything it doesn't cover, rather than calling a server", async () => {
    await expect(devApi.getMatch('m1')).rejects.toThrow('Not in the dev bypass: getMatch');
  });

  it("isn't mistaken for a promise", () => {
    expect((devApi as unknown as { then?: unknown }).then).toBeUndefined();
  });
});
