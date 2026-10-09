import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import type { Api } from '@/api/useApi';
import {
  addPushTokenChangeListener,
  askOnceForPush,
  isNewTap,
  notificationRoute,
  registerCategories,
  registerDevice,
  takeNotificationAction,
  unregisterDevice,
} from '../push';

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: { eas: { projectId: 'project-1' } } } } }));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getDevicePushTokenAsync: jest.fn(async () => ({ type: 'android', data: 'fcm-1' })),
  getExpoPushTokenAsync: jest.fn(async () => ({ type: 'expo', data: 'ExponentPushToken[device]' })),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  setNotificationCategoryAsync: jest.fn(async () => ({})),
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  AndroidImportance: { HIGH: 4 },
}));
jest.mock('expo-task-manager', () => ({ isTaskRegisteredAsync: jest.fn(async () => true) }));

const mocked = Notifications as jest.Mocked<typeof Notifications>;
const permission = (status: string, canAskAgain = true) =>
  ({ status, canAskAgain, granted: status === 'granted', expires: 'never' }) as unknown as Notifications.NotificationPermissionsStatus;

function fakeApi() {
  return { registerPushToken: jest.fn(async () => {}), removePushToken: jest.fn(async () => {}) } as unknown as Api & {
    registerPushToken: jest.Mock;
    removePushToken: jest.Mock;
  };
}

// Set when push.ts loads, so read before beforeEach clears it.
const handler = mocked.setNotificationHandler.mock.calls[0][0]!;

beforeEach(() => jest.clearAllMocks());

describe('the notification handler', () => {
  it('shows a notice that arrives while the app is open as a banner, with its sound', async () => {
    // Android shows no banner for a silent notification - it goes straight to the shade.
    const behavior = await handler.handleNotification({} as Notifications.Notification);
    expect(behavior).toMatchObject({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true });
  });
});

describe('registerDevice', () => {
  it("registers this device's token once the player has allowed notifications", async () => {
    mocked.getPermissionsAsync.mockResolvedValue(permission('granted'));
    const api = fakeApi();

    expect(await registerDevice(api, { ask: false })).toBe(true);
    expect(mocked.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: 'project-1',
      devicePushToken: { type: 'android', data: 'fcm-1' },
    });
    expect(api.registerPushToken).toHaveBeenCalledWith('ExponentPushToken[device]', expect.stringMatching(/android|ios/), expect.any(Boolean));
  });

  // Android draws the notices with buttons without them unless the app does (drawNotice.ts).
  it('says, on Android, whether the app draws its own notices', async () => {
    mocked.getPermissionsAsync.mockResolvedValue(permission('granted'));
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    const isRegistered = TaskManager.isTaskRegisteredAsync as jest.Mock;
    const api = fakeApi();

    await registerDevice(api, { ask: false });
    expect(api.registerPushToken).toHaveBeenLastCalledWith('ExponentPushToken[device]', 'android', true);
    expect(isRegistered).toHaveBeenCalledWith('draw-notice');

    isRegistered.mockResolvedValueOnce(false);
    await registerDevice(api, { ask: false });
    expect(api.registerPushToken).toHaveBeenLastCalledWith('ExponentPushToken[device]', 'android', false);
    os.restore();
  });

  it("doesn't on iOS, which adds the buttons itself", async () => {
    mocked.getPermissionsAsync.mockResolvedValue(permission('granted'));
    const os = jest.replaceProperty(Platform, 'OS', 'ios');
    const api = fakeApi();

    await registerDevice(api, { ask: false });
    expect(api.registerPushToken).toHaveBeenCalledWith('ExponentPushToken[device]', 'ios', false);
    os.restore();
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

describe('addPushTokenChangeListener', () => {
  it('reports a new token, but not the same one again', async () => {
    mocked.getPermissionsAsync.mockResolvedValue(permission('granted'));
    await registerDevice(fakeApi(), { ask: false }); // last seen: fcm-1
    const onChange = jest.fn();
    addPushTokenChangeListener(onChange);
    const emit = mocked.addPushTokenListener.mock.calls[0][0];
    const event = (data: string) => ({ type: 'android', data }) as Notifications.DevicePushToken;

    // What Android sends back after every fetch of the token.
    emit(event('fcm-1'));
    expect(onChange).not.toHaveBeenCalled();

    emit(event('fcm-2'));
    emit(event('fcm-2'));
    expect(onChange).toHaveBeenCalledTimes(1);
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

describe('isNewTap', () => {
  const tap = (identifier: string) =>
    ({ notification: { request: { identifier } }, actionIdentifier: 'expo.modules.notifications.actions.DEFAULT' }) as unknown as Notifications.NotificationResponse;

  it('opens a tap once, though it arrives both as the last response and as an event', () => {
    expect(isNewTap(tap('a'))).toBe(true);
    expect(isNewTap(tap('a'))).toBe(false);
  });

  it('opens the next tap, on another notification', () => {
    expect(isNewTap(tap('b'))).toBe(true);
    expect(isNewTap(tap('c'))).toBe(true);
  });
});

describe('registerCategories', () => {
  it("gives the Worker's hand over and match over notices their Ready up and Rematch buttons, which open the app", async () => {
    await registerCategories();
    expect(mocked.setNotificationCategoryAsync).toHaveBeenCalledWith('handOver', [
      { identifier: 'ready', buttonTitle: 'Ready up', options: { opensAppToForeground: true } },
    ]);
    expect(mocked.setNotificationCategoryAsync).toHaveBeenCalledWith('matchOver', [
      { identifier: 'rematch', buttonTitle: 'Rematch', options: { opensAppToForeground: true } },
    ]);
  });
});

describe('takeNotificationAction', () => {
  const pressed = (actionIdentifier: string, url = '/match/m1') =>
    ({
      notification: { request: { identifier: 'n1', content: { data: { url } } } },
      actionIdentifier,
    }) as unknown as Notifications.NotificationResponse;
  const api = () =>
    ({ readyUp: jest.fn(async () => ({})), rematch: jest.fn(async () => ({})) }) as unknown as Api & {
      readyUp: jest.Mock;
      rematch: jest.Mock;
    };

  it("does what the match screen's button would, for the match the notice is about", async () => {
    const a = api();
    expect(await takeNotificationAction(a, pressed('ready'))).toBe(true);
    expect(a.readyUp).toHaveBeenCalledWith('m1', true);
    expect(await takeNotificationAction(a, pressed('rematch'))).toBe(true);
    expect(a.rematch).toHaveBeenCalledWith('m1');
  });

  it('does nothing for a plain tap, or a notice that names no match', async () => {
    const a = api();
    expect(await takeNotificationAction(a, pressed('expo.modules.notifications.actions.DEFAULT'))).toBe(false);
    expect(await takeNotificationAction(a, pressed('ready', '/profile'))).toBe(false);
    expect(a.readyUp).not.toHaveBeenCalled();
    expect(a.rematch).not.toHaveBeenCalled();
  });
});
