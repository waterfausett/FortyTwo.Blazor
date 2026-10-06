// How an Auth0 user is shown: to themselves (toUserResponse) and to other players (toPublicUser).
import type { Auth0User } from '../auth0Management';
import type { PublicUser, UserProfile } from '@fortytwo/api-types';

// An Auth0 user plus what to show them as, and their settings:
//   picture: their own user_metadata.picture when it isn't blank, else Auth0's.
//   displayName: user_metadata.displayName ?? nickname ?? name ?? email ?? "Unknown User ({id})".
//   highlightPlayable: off unless they've turned it on.
//   pushNotifications: on unless they've turned it off.
export function toUserResponse(u: Auth0User): UserProfile {
  const effectivePicture = u.user_metadata?.picture?.trim() ? u.user_metadata.picture : u.picture;
  const displayName =
    u.user_metadata?.displayName ?? u.nickname ?? u.name ?? u.email ?? `Unknown User (${u.user_id})`;
  return {
    ...u,
    picture: effectivePicture,
    displayName,
    highlightPlayable: u.user_metadata?.highlightPlayable === true,
    pushNotifications: u.user_metadata?.pushNotifications !== false,
  };
}

// What any player may see of another: enough to show them at the table, and nothing that
// identifies them outside the game (email, real name).
export function toPublicUser(u: Auth0User): PublicUser {
  const { user_id, displayName, picture } = toUserResponse(u);
  return { user_id, displayName, picture };
}
