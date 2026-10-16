import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppAnnouncement } from './AppAnnouncement';

// Node's own (file-less) localStorage global shadows jsdom's, leaving it undefined here - so each
// test gets an in-memory one.
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
}

describe('AppAnnouncement', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows both store badges as coming soon', () => {
    render(<AppAnnouncement />);
    expect(screen.getByLabelText('Google Play, coming soon')).toBeTruthy();
    expect(screen.getByLabelText('App Store, coming soon')).toBeTruthy();
  });

  it('stays gone once dismissed', () => {
    const { unmount } = render(<AppAnnouncement />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss app announcement' }));
    expect(screen.queryByLabelText('Mobile apps')).toBeNull();
    unmount();
    render(<AppAnnouncement />);
    expect(screen.queryByLabelText('Mobile apps')).toBeNull();
  });
});
