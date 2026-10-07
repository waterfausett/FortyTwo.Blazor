-- What other players see of each player (PublicUser): their display name and picture, kept here so
-- the lobby and the match screens' name lookups don't each cost an Auth0 Management API call. Auth0
-- stays the source of truth; users/publicUsers.ts fills a row on first lookup and refreshes it when
-- the player fetches or saves their profile. Deleting an account must delete its row.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  picture TEXT,
  updated_on TEXT NOT NULL
);
