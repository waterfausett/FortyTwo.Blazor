// Inviting friends to a match. The link is the web app's address for the match on the Worker -
// https://<worker>/match/<id> - so it works for anyone: Android opens it in this app when it's
// installed (an App Link, set up in app.config.js), and otherwise it opens the web app, where
// they can sign in and pick a seat. Without an https Worker (local development), it falls back to
// the app's own scheme, fortytwo://match/<id>, which only opens the app.
import * as Linking from 'expo-linking';
import { Share } from 'react-native';
import { config } from '@/config';

export function inviteLink(matchId: string, apiOrigin = config.apiOrigin): string {
  const id = encodeURIComponent(matchId);
  return apiOrigin.startsWith('https://') ? `${apiOrigin}/match/${id}` : Linking.createURL(`match/${id}`);
}

// Opens the system share sheet with the invite.
export async function shareInvite(matchId: string): Promise<void> {
  const link = inviteLink(matchId);
  await Share.share({ message: `Join my game of Forty-Two: ${link}` });
}
