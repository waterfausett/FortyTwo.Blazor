import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import type { Env } from '../src/index';
import { messagesFor, sendNotices } from '../src/push/send';
import { saveToken } from '../src/push/tokens';
import type { Notice } from '../src/push/notices';

const testEnv = env as unknown as Env;
const turn = (playerId: string): Notice => ({ playerId, kind: 'turn', title: 'Your bid', body: 'Game 1 is waiting on you.', matchId: 'm1' });

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('messagesFor', () => {
  it("sends each notice to every one of its player's devices, opening the match", () => {
    const messages = messagesFor([turn('p1')], [
      { token: 'ExponentPushToken[a]', userId: 'p1' },
      { token: 'ExponentPushToken[b]', userId: 'p1' },
      { token: 'ExponentPushToken[c]', userId: 'p2' },
    ]);
    expect(messages.map((m) => m.to)).toEqual(['ExponentPushToken[a]', 'ExponentPushToken[b]']);
    expect(messages[0]).toMatchObject({
      title: 'Your bid',
      data: { url: '/match/m1' },
      priority: 'high',
      channelId: 'game',
      collapseId: 'match-m1',
    });
  });
});

describe('sendNotices', () => {
  it('posts to Expo and forgets a device Expo says is no longer registered', async () => {
    await saveToken(testEnv.DB, 'p1', 'ExponentPushToken[live]', 'android');
    await saveToken(testEnv.DB, 'p1', 'ExponentPushToken[gone]', 'android');
    let sent: { to: string }[] = [];
    fetchMock
      .get('https://exp.host')
      .intercept({ path: '/--/api/v2/push/send', method: 'POST' })
      .reply((opts) => {
        sent = JSON.parse(String(opts.body));
        return {
          statusCode: 200,
          data: JSON.stringify({
            data: sent.map((m) =>
              m.to === 'ExponentPushToken[gone]'
                ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
                : { status: 'ok', id: 'ticket' }
            ),
          }),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      });

    await sendNotices(testEnv, [turn('p1')]);

    expect(sent.map((m) => m.to).sort()).toEqual(['ExponentPushToken[gone]', 'ExponentPushToken[live]']);
    const { results } = await testEnv.DB.prepare('SELECT token FROM push_tokens WHERE user_id = ?1').bind('p1').all();
    expect(results).toEqual([{ token: 'ExponentPushToken[live]' }]);
  });

  it("sends nothing for a player with no devices, and doesn't throw when Expo fails", async () => {
    await sendNotices(testEnv, [turn('nobody')]);

    await saveToken(testEnv.DB, 'p9', 'ExponentPushToken[p9]', 'ios');
    fetchMock.get('https://exp.host').intercept({ path: '/--/api/v2/push/send', method: 'POST' }).reply(500, 'down');
    await expect(sendNotices(testEnv, [turn('p9')])).resolves.toBeUndefined();
  });
});
