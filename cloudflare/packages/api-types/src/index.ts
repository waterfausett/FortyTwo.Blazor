// The JSON shapes the Worker's REST API sends and the web app reads, kept in one place so the two
// can't drift apart. Types only: nothing here exists at runtime. Match state itself is
// `MatchState` from @fortytwo/rules.

// The error body of every failed request: a rule the action broke (400), a malformed request
// (400), or a match that doesn't exist (404). `detail` may hold <code> markup.
export interface ApiErrorBody {
  title: string;
  detail?: string;
}

export type MatchStatus = 'active' | 'completed';

// One match in the lobby list (GET /api/matches). `teams` is [TeamA, TeamB] display names, each in
// join order; `seats` is the display name at each position 0-3, or null for an open seat. Bots,
// and anyone whose name couldn't be looked up, appear by raw id.
export interface MatchSummary {
  id: string;
  status: MatchStatus;
  playerCount: number;
  updatedOn: string;
  teams: [string[], string[]];
  seats: (string | null)[];
}

// Feature switches the Worker turns on per environment (GET /api/config).
export interface ClientConfig {
  bots: boolean;
}

// A user as Auth0's Management API returns it.
export interface Auth0User {
  user_id: string;
  email?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  nickname?: string;
  // Every Auth0 user has one (their avatar); a player's own `user_metadata.picture` overrides it.
  picture?: string;
  user_metadata?: {
    displayName?: string;
    theme?: 'Light' | 'Dark';
    picture?: string;
    highlightPlayable?: boolean;
    pushNotifications?: boolean;
  };
}

// The caller's own profile (GET /api/users/profile): their Auth0 user, with `picture` resolved to
// the one to show, the name to show them by, and their settings with defaults filled in.
export interface UserProfile extends Auth0User {
  displayName: string;
  // On their turn, outline the dominoes they may legally play and fade the rest. A help a player
  // opts into; off unless they've turned it on.
  highlightPlayable: boolean;
  // Push notifications to the mobile app when it's their turn, a hand ends or a game starts. On
  // unless they've turned it off. Each device also needs the player's permission.
  pushNotifications: boolean;
}

// What any player may see of another (POST /api/users/search): enough to show them at the table,
// and nothing that identifies them outside the game.
export type PublicUser = Pick<UserProfile, 'user_id' | 'displayName' | 'picture'>;

// The fields a player may change on their profile (PATCH /api/users). Blank `picture` clears it.
export interface ProfilePatch {
  displayName?: string;
  picture?: string;
  highlightPlayable?: boolean;
  pushNotifications?: boolean;
}
