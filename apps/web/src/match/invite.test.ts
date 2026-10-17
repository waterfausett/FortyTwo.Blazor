import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inviteLink, shareInvite } from './invite';
import { toastInfo } from '../ui/toast';

vi.mock('../ui/toast', () => ({ toastInfo: vi.fn() }));

function setPointer(coarse: boolean) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: coarse })));
}

describe('inviteLink', () => {
  it("is the match's own page", () => {
    expect(inviteLink('m 1', 'https://fortytwo.example')).toBe('https://fortytwo.example/match/m%201');
  });
});

describe('shareInvite', () => {
  const share = vi.fn();
  const writeText = vi.fn();

  beforeEach(() => {
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    share.mockReset();
    writeText.mockReset();
  });

  it('opens the share sheet on a touch device', async () => {
    setPointer(true);
    share.mockResolvedValue(undefined);

    await shareInvite('m1');

    expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: `${window.location.origin}/match/m1` }));
    expect(writeText).not.toHaveBeenCalled();
  });

  it('does nothing more when the share sheet is closed', async () => {
    setPointer(true);
    share.mockRejectedValue(new DOMException('closed', 'AbortError'));

    await shareInvite('m1');

    expect(writeText).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('copies the link on a desktop, and says so', async () => {
    setPointer(false);
    writeText.mockResolvedValue(undefined);

    await shareInvite('m1');

    expect(share).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/match/m1`);
    expect(toastInfo).toHaveBeenCalledWith('Invite link copied', expect.any(String));
  });

  it('shows the link to copy by hand when the clipboard is unavailable', async () => {
    setPointer(false);
    writeText.mockRejectedValue(new Error('denied'));
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null);

    await shareInvite('m1');

    expect(prompt).toHaveBeenCalledWith('Copy this invite link', `${window.location.origin}/match/m1`);
  });
});
