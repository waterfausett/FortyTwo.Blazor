import { Bid, Suit, type MatchState } from '@fortytwo/rules';
import { describeMatch, type MatchSocketOptions } from '@fortytwo/client';
import { DEV_BYPASS, devApi } from '../devBypass';
import { DEV_PLAYER_ID, connectDevMatchSocket, devTiming } from '../devMatches';

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
    await expect(devApi.poke('m1')).rejects.toThrow('Not in the dev bypass: poke');
    await expect(devApi.getMatch('m1')).rejects.toThrow('Not in the dev bypass: match m1');
  });

  it("isn't mistaken for a promise", () => {
    expect((devApi as unknown as { then?: unknown }).then).toBeUndefined();
  });
});

describe('the canned matches', () => {
  it.each([
    ['dev-bidding', (v: ReturnType<typeof describeMatch>) => v.canBid],
    ['dev-trump', (v: ReturnType<typeof describeMatch>) => v.canSelectTrump],
    ['dev-playing', (v: ReturnType<typeof describeMatch>) => v.isMyTurnToPlay],
    ['dev-hand-over', (v: ReturnType<typeof describeMatch>) => v.isHandOver && !v.iAmReady],
  ])('opens %s at that point, waiting on you', async (id, waitingOnMe) => {
    const match = await devApi.getMatch(id);
    expect(waitingOnMe(describeMatch(match, DEV_PLAYER_ID))).toBe(true);
  });

  it('sends a move over the socket, and starts over when opened again', async () => {
    const seen: MatchState[] = [];
    const options = { matchId: 'dev-bidding', onOpen: () => {}, onMatch: (m: MatchState) => seen.push(m) };
    const disconnect = connectDevMatchSocket(options as unknown as MatchSocketOptions);
    await devApi.bid('dev-bidding', Bid.Thirty);
    await new Promise((resolve) => setTimeout(resolve, devTiming.broadcastMs));
    expect(describeMatch(seen.at(-1)!, DEV_PLAYER_ID).canBid).toBe(false);
    disconnect();

    connectDevMatchSocket(options as unknown as MatchSocketOptions)();
    expect(describeMatch(seen.at(-1)!, DEV_PLAYER_ID).canBid).toBe(true);
  });

  it('turns away a move the rules refuse', async () => {
    await expect(devApi.setTrump('dev-bidding', Suit.Sixes)).rejects.toThrow();
  });
});
