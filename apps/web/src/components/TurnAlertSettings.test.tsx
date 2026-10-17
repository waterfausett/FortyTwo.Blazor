import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAlertPrefs, writeAlertPrefs } from '../match/alertPrefs';
import { TurnAlertSettings } from './TurnAlertSettings';

const { playChimeMock } = vi.hoisted(() => ({ playChimeMock: vi.fn() }));
vi.mock('../ui/chime', () => ({ playChime: playChimeMock }));

// Node's own (file-less) localStorage global shadows jsdom's, leaving it undefined here.
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
}

let permission: NotificationPermission;
const requestPermissionMock = vi.fn<() => Promise<NotificationPermission>>();

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  permission = 'default';
  vi.stubGlobal('Notification', {
    get permission() {
      return permission;
    },
    requestPermission: requestPermissionMock,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function desktopToggle(): HTMLInputElement {
  return screen.getByRole('checkbox', { name: /desktop notifications/i }) as HTMLInputElement;
}

describe('TurnAlertSettings', () => {
  describe('sound', () => {
    it('shows the saved choice', () => {
      writeAlertPrefs({ sound: 'always', desktop: false });
      render(<TurnAlertSettings />);
      expect((screen.getByRole('radio', { name: /always/i }) as HTMLInputElement).checked).toBe(true);
    });

    it('defaults to chiming only while away', () => {
      render(<TurnAlertSettings />);
      expect((screen.getByRole('radio', { name: /when i'm away/i }) as HTMLInputElement).checked).toBe(true);
    });

    it('saves a new choice straight away and plays a preview', () => {
      render(<TurnAlertSettings />);
      fireEvent.click(screen.getByRole('radio', { name: /always/i }));
      expect(readAlertPrefs().sound).toBe('always');
      expect(playChimeMock).toHaveBeenCalledTimes(1);
    });

    it('plays no preview when switched off', () => {
      render(<TurnAlertSettings />);
      fireEvent.click(screen.getByRole('radio', { name: /off/i }));
      expect(readAlertPrefs().sound).toBe('off');
      expect(playChimeMock).not.toHaveBeenCalled();
    });
  });

  describe('desktop notifications', () => {
    it('asks the browser first, and turns on once allowed', async () => {
      requestPermissionMock.mockImplementation(async () => (permission = 'granted'));
      render(<TurnAlertSettings />);
      expect(desktopToggle().checked).toBe(false);

      await act(async () => {
        fireEvent.click(desktopToggle());
      });

      expect(requestPermissionMock).toHaveBeenCalled();
      expect(desktopToggle().checked).toBe(true);
      expect(readAlertPrefs().desktop).toBe(true);
    });

    it('stays off, and says why, when the browser refuses', async () => {
      requestPermissionMock.mockImplementation(async () => (permission = 'denied'));
      render(<TurnAlertSettings />);

      await act(async () => {
        fireEvent.click(desktopToggle());
      });

      expect(desktopToggle().checked).toBe(false);
      expect(readAlertPrefs().desktop).toBe(false);
      expect(screen.getByText(/blocked/i)).not.toBeNull();
    });

    it('turns off without asking', () => {
      permission = 'granted';
      writeAlertPrefs({ sound: 'away', desktop: true });
      render(<TurnAlertSettings />);
      fireEvent.click(desktopToggle());
      expect(requestPermissionMock).not.toHaveBeenCalled();
      expect(readAlertPrefs().desktop).toBe(false);
    });

    it('shows as off when saved on but no longer allowed', () => {
      permission = 'denied';
      writeAlertPrefs({ sound: 'away', desktop: true });
      render(<TurnAlertSettings />);
      expect(desktopToggle().checked).toBe(false);
      expect(desktopToggle().disabled).toBe(true);
      expect(screen.getByText(/blocked/i)).not.toBeNull();
    });

    it("can't be switched on where the browser has no notifications", () => {
      vi.stubGlobal('Notification', undefined);
      render(<TurnAlertSettings />);
      expect(desktopToggle().disabled).toBe(true);
      expect(screen.getByText(/doesn't support/i)).not.toBeNull();
    });
  });
});
