// Whether to offer the Lobby's "New to 42?" card, and marking the rules seen (dismissing the card
// or opening the rules screen). Saved to the profile, so it holds on web too; useSaveProfile shows
// the change at once and puts it back if the save fails.
import { shouldOfferHowToPlay } from '@fortytwo/client';
import { useProfile, useSaveProfile } from './useProfile';

export function useHowToPlay(): { offer: boolean; markSeen: () => void } {
  const profile = useProfile();
  const save = useSaveProfile();
  const offer = shouldOfferHowToPlay(profile.data);

  // Only a profile that says "not seen" is worth a save: one that's loading, already seen, or from
  // a worker that doesn't know the setting is left alone.
  function markSeen() {
    if (offer && !save.isPending) save.mutate({ seenHowToPlay: true });
  }

  return { offer, markSeen };
}
