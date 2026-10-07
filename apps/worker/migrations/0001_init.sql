CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
  player_count INTEGER NOT NULL DEFAULT 0,
  updated_on TEXT NOT NULL
);

CREATE TABLE match_players (
  match_id TEXT NOT NULL REFERENCES matches(id),
  player_id TEXT NOT NULL,
  PRIMARY KEY (match_id, player_id)
);

CREATE INDEX idx_match_players_player ON match_players(player_id);
CREATE INDEX idx_matches_status ON matches(status);
