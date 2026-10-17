// Inviting friends to a match: the link is this match's own page, which shows anyone who isn't
// seated the seat picker (after signing in). The mobile app sends the same link
// (apps/mobile/src/linking/invite.ts), which Android opens in the app when it's installed.
import { toastInfo } from '../ui/toast';

export function inviteLink(matchId: string, origin = window.location.origin): string {
  return `${origin}/match/${encodeURIComponent(matchId)}`;
}

// Phones and tablets get the system share sheet, as in the mobile app. Elsewhere the link is
// copied: a desktop browser's share dialog (Windows has one) is a detour for something usually
// pasted into a chat that's already open.
function canShare(): boolean {
  return typeof navigator.share === 'function' && window.matchMedia?.('(pointer: coarse)').matches === true;
}

export async function shareInvite(matchId: string): Promise<void> {
  const url = inviteLink(matchId);
  if (canShare()) {
    try {
      await navigator.share({ title: 'Forty-Two', text: 'Join my game of Forty-Two', url });
      return;
    } catch (error) {
      // Closing the share sheet isn't a failure; anything else falls back to copying.
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toastInfo('Invite link copied', 'Send it to whoever you want at the table.');
  } catch {
    // No clipboard (an insecure origin, or permission refused): show the link to copy by hand.
    window.prompt('Copy this invite link', url);
  }
}
