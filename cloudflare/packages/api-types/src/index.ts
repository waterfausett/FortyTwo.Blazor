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

// How a match was started (the rules package's MatchMode, repeated here since this package
// carries no runtime dependencies).
export type MatchMode = 'live' | 'daily' | 'custom' | 'bots';

// Who an Active match is waiting on, looked up from the match itself when the list loads:
// `kind` is a turn (one player) or a ready-up between hands (everyone not yet ready);
// `waitingOn` are display names; `yours` says whether the viewer is among them.
export interface TurnSummary {
  kind: 'turn' | 'ready';
  yours: boolean;
  waitingOn: string[];
}

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
  mode: MatchMode;
  // Active list only; null when the match couldn't say in time (the row shows without it).
  turn?: TurnSummary | null;
}

// One page of a lobby list (GET /api/matches). `nextCursor` goes back as `?cursor=` for the next
// page; null on the last one.
export interface MatchPage {
  matches: MatchSummary[];
  nextCursor: string | null;
}

// How a poke (POST /api/matches/:id/poke) reached the player whose turn it is: a push
// notification, a nudge on the match they have open, or not at all - they don't have the match
// open and have no device to notify. Only a poke that got through uses up the turn's one poke.
export type PokeDelivery = 'push' | 'inApp' | 'none';

export interface PokeResult {
  delivered: PokeDelivery;
}

// Feature switches the Worker turns on per environment (GET /api/config).
export interface ClientConfig {
  bots: boolean;
  // Whether to open the presence socket and show the online count.
  presence: boolean;
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
    seenHowToPlay?: boolean;
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
  // Whether they've dismissed the Lobby's "New to 42?" card or opened How to play. False until
  // they have.
  seenHowToPlay: boolean;
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
  seenHowToPlay?: boolean;
}

// What the presence socket (GET /presence/ws) sends: how many players have the app open. On
// connect, then at most once per the Worker's PRESENCE_BROADCAST_MS (index.ts) as people come
// and go.
export interface PresenceMessage {
  type: 'online';
  online: number;
}

// The caller's own lifetime stats (GET /api/users/stats), counted from completed matches. A game
// is a whole match; bids are the hands they took the bid on. Each filter is its own summary.
export interface BestPartner {
  user: PublicUser;
  won: number;
  lost: number;
}

// A trump a winning bid named, as @fortytwo/rules' TrumpKey: every Low variant is 'low'.
export type TrumpKey = 'low' | 'followMe' | 'blanks' | 'aces' | 'deuces' | 'threes' | 'fours' | 'fives' | 'sixes';

export interface FavoriteTrump {
  trump: TrumpKey;
  // How many of their winning bids named it.
  times: number;
}

export interface StatsSummary {
  played: number;
  won: number;
  lost: number;
  marksWon: number;
  bidsWon: number;
  bidsMade: number;
  bidsSet: number;
  // Over their winning points bids (30-42), to one decimal place; null with none.
  averagePointsBid: number | null;
  // Winning bids of a mark or more: 42 and up, Plunge included.
  marksBids: number;
  // The trump they name most on bids they win; a tie goes to the higher suit. Null with no bids won.
  favoriteTrump: FavoriteTrump | null;
  // The human they win with most, over at least 3 games together.
  bestPartner: BestPartner | null;
}

export interface PlayerStats {
  all: StatsSummary;
  // No seat held a bot.
  humansOnly: StatsSummary;
  // At least one seat held a bot.
  withBots: StatsSummary;
}

export type StatsFilter = keyof PlayerStats;
