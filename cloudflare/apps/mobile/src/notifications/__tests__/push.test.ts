import * as Notifications from 'expo-notifications';
import type { Api } from '@/api/useApi';
import { askOnceForPush, notificationRoute, registerDevice, unregisterDevice } from '../push';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: { eas: { projectId: 'project-1' } } } } }));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(async () => ({ type: 'expo', data: 'ExponentPushToken[device]' })),
  AndroidImportance: { HIGH: 4 },
}));

const mocked = Notifications as jest.Mocked<typeof Notifications>;
const permission = (status: string, canAskAgain = true) =>
  ({ status, canAskAgain, granted: status === 'granted', expires: 'never' }) as unknown as Notifications.NotificationPermissionsStatus;

function fakeApi() {
  return { registerPushToken: jest.fn(async () => {}), removePushToken: jest.fn(async () => {}) } as unknown as Api & {
    registerPushToken: jest.Mock;
    removePushToken: jest.Mock;
  };
}

beforeEach(() => jest.clearAllMocks());

describe('registerDevice', () => {
  it("registers this device's token once the player has allowed notifications", async () => {
    mocked.getPermissionsAsync.mockResolvedValue(permission('granted'));
    const api = fakeApi();

    expect(await registerDevice(api, { ask: false })).toBe(true);
    expect(mocked.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'project-1' });
    expect(api.registerPushToken).toHaveBeenCalledWith('ExponentPushToken[device]', expect.stringMatching(/android|ios/));
  });

  it("doesn't ask for permission unless told to, and registers nothing without it", async () => {
    mocked.getPermissionsAsync.mockResolvedValue(permission('undetermined'));
    const api = fakeApi();

    expect(await registerDevice(api, { ask: false })).toBe(false);
    expect(mocked.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(api.registerPushToken).not.toHaveBeenCalled();
  });

  it('asks when told to, and registers if the player says yes', async () => {
    mocked.getPermissionsAsync.mockResolvedValue(permission('undetermined'));
    mocked.requestPermissionsAsync.mockResolvedValue(permission('granted'));
    const api = fakeApi();

    expect(await registerDevice(api, { ask: true })).toBe(true);
    expect(api.registerPushToken).toHaveBeenCalled();
  });

  it("doesn't ask again once the OS won't show the prompt", async () => {
    mocked.getPermissionsAsync.mockResolvedValue(permission('denied', false));
    expect(await registerDevice(fakeApi(), { ask: true })).toBe(false);
    expect(mocked.requestPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe('unregisterDevice', () => {
  it('removes the token, or does nothing without permission', async () => {
    const api = fakeApi();
    mocked.getPermissionsAsync.mockResolvedValue(permission('granted'));
    await unregisterDevice(api);
    expect(api.removePushToken).toHaveBeenCalledWith('ExponentPushToken[device]');

    api.removePushToken.mockClear();
    mocked.getPermissionsAsync.mockResolvedValue(permission('denied'));
    await unregisterDevice(api);
    expect(api.removePushToken).not.toHaveBeenCalled();
  });
});

describe('askOnceForPush', () => {
  it('asks only the first time in a run of the app', async () => {
    mocked.getPermissionsAsync.mockResolvedValue(permission('undetermined'));
    mocked.requestPermissionsAsync.mockResolvedValue(permission('denied'));
    askOnceForPush(fakeApi());
    askOnceForPush(fakeApi());
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    expect(mocked.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });
});

describe('notificationRoute', () => {
  const tapped = (data: unknown) => ({ request: { content: { data } } }) as unknown as Notifications.Notification;

  it("opens the match the Worker put in the notification, and nothing else", () => {
    expect(notificationRoute(tapped({ url: '/match/m1' }))).toBe('/match/m1');
    expect(notificationRoute(tapped({ url: 'https://evil.example/x' }))).toBeNull();
    expect(notificationRoute(tapped({}))).toBeNull();
    expect(notificationRoute(tapped(null))).toBeNull();
  });
});
