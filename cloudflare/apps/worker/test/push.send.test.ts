import { describe, expect, it, beforeAll, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { fetchMock } from './fetchMock';
import type { Env } from '../src/index';
import { messagesFor, sendNotices } from '../src/push/send';
import { TOKEN_REFRESH_MS, saveToken } from '../src/push/tokens';
import type { Notice, NoticeKind } from '../src/push/notices';
import { saveUsers } from '../src/users/publicUsers';
import { Teams } from '@fortytwo/rules';

const testEnv = env as unknown as Env;
// p1 and p3 against p2 and p4, TeamA 4 marks to TeamB's 3.
const seats = [
  { playerId: 'p1', position: 0 },
  { playerId: 'p2', position: 1 },
  { playerId: 'p3', position: 2 },
  { playerId: 'p4', position: 3 },
];
const marks = { [Teams.TeamA]: 4, [Teams.TeamB]: 3 };
const notice = (playerId: string, kind: NoticeKind, headline: string, extra: Partial<Notice> = {}): Notice => ({
  playerId,
  kind,
  headline,
  matchId: 'm1',
  players: seats,
  marks,
  ...extra,
});
const turn = (playerId: string): Notice => notice(playerId, 'turn', 'Your bid');
const names = new Map([
  ['p1', 'Ann'],
  ['p2', 'Alex'],
  ['p3', 'Sam'],
  ['p4', 'Jo'],
]);
const tokenFor = (userId: string) => [{ token: `ExponentPushToken[${userId}]`, userId }];

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

// Storage lasts the whole file, so each test starts with no devices registered.
beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM push_tokens').run();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('saveToken', () => {
  const updatedOn = async (token: string) =>
    (await testEnv.DB.prepare('SELECT updated_on FROM push_tokens WHERE token = ?1').bind(token).first<{ updated_on: string }>())
      ?.updated_on;

  it('leaves the row alone when the same device registers again, refreshing it at most daily', async () => {
    const token = 'ExponentPushToken[again]';
    const first = new Date('2026-10-01T00:00:00Z');
    await saveToken(testEnv.DB, 'p1', token, 'android', first);

    const soon = new Date(first.getTime() + 60_000);
    await saveToken(testEnv.DB, 'p1', token, 'android', soon);
    expect(await updatedOn(token)).toBe(first.toISOString());

    const nextDay = new Date(first.getTime() + TOKEN_REFRESH_MS + 1);
    await saveToken(testEnv.DB, 'p1', token, 'android', nextDay);
    expect(await updatedOn(token)).toBe(nextDay.toISOString());
  });

  it('still moves the token to whoever signs in on the device next', async () => {
    const token = 'ExponentPushToken[moved]';
    const at = new Date('2026-10-01T00:00:00Z');
    await saveToken(testEnv.DB, 'p1', token, 'android', at);
    await saveToken(testEnv.DB, 'p2', token, 'android', at);
    const row = await testEnv.DB.prepare('SELECT user_id FROM push_tokens WHERE token = ?1').bind(token).first<{ user_id: string }>();
    expect(row?.user_id).toBe('p2');
  });
});

describe('messagesFor', () => {
  it("sends each notice to every one of its player's devices, opening the match", () => {
    const messages = messagesFor(
      [turn('p1')],
      [
        { token: 'ExponentPushToken[a]', userId: 'p1' },
        { token: 'ExponentPushToken[b]', userId: 'p1' },
        { token: 'ExponentPushToken[c]', userId: 'p2' },
      ],
      names
    );
    expect(messages.map((m) => m.to)).toEqual(['ExponentPushToken[a]', 'ExponentPushToken[b]']);
    expect(messages[0]).toMatchObject({
      title: 'You & Sam vs Alex & Jo',
      body: 'Your bid · Us 4, Them 3',
      data: { url: '/match/m1' },
      priority: 'high',
      channelId: 'game',
      collapseId: 'match-m1',
    });
  });

  it("names the match by its teams from each recipient's side, with the score the same way round", () => {
    const [toP1, toP4] = messagesFor([turn('p1'), turn('p4')], [...tokenFor('p1'), ...tokenFor('p4')], names);
    expect(toP1).toMatchObject({ title: 'You & Sam vs Alex & Jo', body: 'Your bid · Us 4, Them 3' });
    expect(toP4).toMatchObject({ title: 'You & Alex vs Ann & Sam', body: 'Your bid · Us 3, Them 4' });
  });

  it('says what happened the same way for every kind, and how long it stays worth delivering', () => {
    const sent = (n: Notice) => {
      const [m] = messagesFor([n], tokenFor('p1'), names);
      return { body: m.body, ttl: m.ttl };
    };
    expect(sent(turn('p1'))).toEqual({ body: 'Your bid · Us 4, Them 3', ttl: 12 * 3600 });
    expect(sent(notice('p1', 'poke', "You've been poked", { marks: undefined, detail: 'The table is waiting on you.' }))).toEqual({
      body: "You've been poked · The table is waiting on you.",
      ttl: 12 * 3600,
    });
    expect(sent(notice('p1', 'handOver', 'Hand over', { detail: 'Ready up for the next hand.' }))).toEqual({
      body: 'Hand over · Us 4, Them 3. Ready up for the next hand.',
      ttl: 12 * 3600,
    });
    expect(sent(notice('p1', 'matchOver', 'Match over', { detail: 'See how it ended, or ask for a rematch.' }))).toEqual({
      body: 'Match over · Us 4, Them 3. See how it ended, or ask for a rematch.',
      ttl: 24 * 3600,
    });
    expect(sent(notice('p1', 'started', 'Game on', { marks: undefined, detail: 'All four seats are taken.' }))).toEqual({
      body: 'Game on · All four seats are taken.',
      ttl: 3600,
    });
  });

  it("calls a player it has no name for by their seat, as the apps do, and bots by number", () => {
    const players = [seats[0], { playerId: 'bot-2', position: 1 }, seats[2], seats[3]];
    const [m] = messagesFor([notice('p1', 'turn', 'Your bid', { players })], tokenFor('p1'), new Map([['p3', 'Sam']]));
    expect(m.title).toBe('You & Sam vs Bot 2 & Player 4');
    expect(messagesFor([turn('p1')], tokenFor('p1'))[0].title).toBe('You & Player 3 vs Player 2 & Player 4');
  });
});

describe('sendNotices', () => {
  it('looks the players up by name for the title', async () => {
    await saveUsers(testEnv.DB, [...names].map(([user_id, displayName]) => ({ user_id, displayName })));
    await saveToken(testEnv.DB, 'p2', 'ExponentPushToken[p2]', 'android');
    let sent: { title: string; body: string }[] = [];
    fetchMock
      .get('https://exp.host')
      .intercept({ path: '/--/api/v2/push/send', method: 'POST' })
      .reply((opts) => {
        sent = JSON.parse(String(opts.body));
        return { statusCode: 200, data: JSON.stringify({ data: sent.map(() => ({ status: 'ok', id: 't' })) }) };
      });

    await sendNotices(testEnv, [turn('p2')]);

    expect(sent).toMatchObject([{ title: 'You & Jo vs Ann & Sam', body: 'Your bid · Us 3, Them 4' }]);
  });

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
