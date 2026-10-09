import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

jest.mock('expo-constants', () => ({ __esModule: true, default: {} }));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationCategoryAsync: jest.fn(async () => ({})),
  registerTaskAsync: jest.fn(async () => null),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
}));
jest.mock('expo-task-manager', () => ({ defineTask: jest.fn() }));

jest.replaceProperty(Platform, 'OS', 'android');

// Loaded for its side effects: the task is defined and registered as the module loads.
require('../drawNotice');

const mocked = Notifications as jest.Mocked<typeof Notifications>;
const defineTask = TaskManager.defineTask as jest.Mock;
const [taskName, task] = defineTask.mock.calls[0];
const run = (data: unknown) => task({ data, error: null, executionInfo: { taskName, eventId: 'e' } });

const handOver = {
  url: '/match/m1',
  title: 'You & Sam vs Alex & Jo',
  body: 'We took the hand. Ready for the next one?\nUs 5, Them 3',
  categoryId: 'handOver',
  tag: 'match-m1',
};

beforeEach(() => mocked.scheduleNotificationAsync.mockClear());

it('runs for every push that reaches the app, from launch', () => {
  expect(mocked.registerTaskAsync).toHaveBeenCalledWith(taskName);
});

it("draws a notice the Worker left to it, with its buttons, in the match's place in the shade", async () => {
  await run({ notification: null, data: { dataString: JSON.stringify(handOver) } });

  expect(mocked.scheduleNotificationAsync).toHaveBeenCalledWith({
    identifier: 'match-m1',
    content: {
      title: 'You & Sam vs Alex & Jo',
      body: 'We took the hand. Ready for the next one?\nUs 5, Them 3',
      data: { url: '/match/m1' },
      categoryIdentifier: 'handOver',
      sound: 'default',
    },
    trigger: { channelId: 'game' },
  });
});

it('leaves alone a push Android has drawn, a button pressed, and anything else', async () => {
  await run({ notification: { title: 'Your bid' }, data: { dataString: JSON.stringify({ url: '/match/m1' }) } });
  await run({ actionIdentifier: 'ready', notification: {} });
  await run({ notification: null, data: { dataString: 'not json' } });
  await run({ notification: null, data: {} });

  expect(mocked.scheduleNotificationAsync).not.toHaveBeenCalled();
});
